import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

// The real cli.ts, because makeApprovalPrompt is not exported and the wiring is half of what is
// being asserted, with a fake runLoop standing in for the model round-trip so the only thing this
// pty exercises is the approval prompt. It reports the answer AND the run's own signal: `false`
// alone is indistinguishable from a typed "n", and `aborted=true` is what says the press travelled
// interface -> deliverSignal -> signals.ts's cancel slot -> cli.ts's controller. run() then ends in
// raiseSignal, so the child dies by SIGINT exactly as it does in production.
function childScript(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  const answer = await opts.approvalPrompt("write_file", { path: "a.txt" }, opts.signal);`,
    `  console.log("\\nPROMPT answer=" + answer + " aborted=" + opts.signal.aborted);`,
    `  yield { type: "done", reason: "aborted" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["write", "hello.txt"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `});`,
  ].join("\n");
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

// Shaped after tests/signals.test.ts's harness — same accumulate-and-poll, same reason: the press
// has to land after the prompt is up, and a sleep would be a race. What is added is the pty.
// `script` is the only pty allocator available without a new dependency, and its two flavours
// disagree on argument order: util-linux takes the command with -c and the typescript file as a
// positional, BSD/macOS takes the typescript file first and the command as argv. A pipe would not
// do — raw mode is the entire mechanism, and over a pipe 0x03 could never have raised a signal in
// the first place, so the test would prove nothing.
function startChild(scriptPath: string, cwd: string): {
  child: ReturnType<typeof spawn>;
  exited: Promise<Exit>;
  sawLine: (line: string) => Promise<void>;
} {
  const args =
    process.platform === "darwin"
      ? ["-q", "/dev/null", process.execPath, scriptPath]
      : ["-qec", `${process.execPath} ${scriptPath}`, "/dev/null"];
  const child = spawn("script", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });

  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, stdout }));
  });

  const sawLine = async (line: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!stdout.includes(line) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    if (!stdout.includes(line)) throw new Error(`child never printed ${JSON.stringify(line)}; got ${JSON.stringify(stdout)}`);
  };

  return { child, exited, sawLine };
}

// Windows has no pty to allocate and no `script`, and its process.kill(pid, "SIGINT") terminates
// without running any listener — the same constraint every other cancellation case in this repo
// works under. Real execution is the WSL box and CI's ubuntu/macos legs; a green Windows run means
// this case SKIPPED.
describe.skipIf(process.platform === "win32")("approval prompt on a real terminal", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seri-pty-approval-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a real Ctrl-C at the prompt cancels the turn instead of killing the process", async () => {
    const scriptPath = join(dir, "child.mjs");
    writeFileSync(scriptPath, childScript(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      // The prompt itself is the readiness marker, and waiting for it is also what keeps the byte
      // out of the window before readline sets raw mode — while the pty is still canonical, 0x03
      // WOULD raise a real SIGINT and the test would pass for the wrong reason.
      await sawLine("[y/N]");
      child.stdin?.write("\x03");
      // stdin is deliberately left open: an EOF on the pty master is its own way to close readline,
      // and it would end this run without the press ever being interpreted.

      const exit = await exited;
      // Asserted on stdout rather than on the exit disposition, because `script` reports its own
      // status rather than the child's uniformly across flavours. Clause (b)'s by-signal death has
      // its own test in tests/signals.test.ts.
      expect(exit.stdout).toContain("answer=false aborted=true");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);
});
