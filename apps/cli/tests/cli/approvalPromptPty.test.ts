import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

// The real cli.ts, because makeApprovalPrompt is not exported and the wiring is half of what is
// being asserted, with a fake runLoop standing in for the model round-trip so the only thing this
// pty exercises is the approval prompt. It reports the answer AND the run's own signal: `"no"`
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

// Three sequential prompts in one child, reusing the same runLoopFake shape as childScript above
// but never aborting: this is the three-way parse's own test, not the cancel path's. Each call
// asks about a differently-named file so `sawLine` can tell one prompt's readiness from the next
// (the rendered line embeds the JSON args), and each answer is logged distinctly so `sawLine` can
// tell one resolved answer from the next.
function childScriptThreeAnswers(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  const a = await opts.approvalPrompt("write_file", { path: "a.txt" }, opts.signal);`,
    `  console.log("\\nPROMPT answer=" + a);`,
    `  const b = await opts.approvalPrompt("write_file", { path: "b.txt" }, opts.signal);`,
    `  console.log("\\nPROMPT answer=" + b);`,
    `  const c = await opts.approvalPrompt("write_file", { path: "c.txt" }, opts.signal);`,
    `  console.log("\\nPROMPT answer=" + c);`,
    `  yield { type: "done", reason: "no-tool-call" };`,
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
// The allocator is python3's stdlib `pty` — stdlib-complete on both CI runners and identical on
// linux and darwin, so there is no platform branch here. `script(1)` was the first attempt and it
// is the reason this comment exists: util-linux and BSD disagree on argument order, and the macOS
// branch produced zero stdout for a full 20 s rather than a spawn error. pty.spawn forks a real
// pty, copies our stdin pipe into the master with os.write and the master back out to STDOUT_FILENO
// unbuffered, and needs no termios of its own (tcgetattr on a pipe raises, which it tolerates). A
// pipe in place of the pty would not do — raw mode is the entire mechanism, and over a pipe 0x03
// could never have raised a signal in the first place, so the test would prove nothing.
function startChild(scriptPath: string, cwd: string): {
  child: ReturnType<typeof spawn>;
  exited: Promise<Exit>;
  sawLine: (line: string) => Promise<void>;
} {
  const args = ["-c", "import pty, sys; pty.spawn(sys.argv[1:])", process.execPath, scriptPath];
  const child = spawn("python3", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });

  // A runner without `python3` reports it as an 'error' event, not as a throw. Unhandled, that
  // takes the whole test process down instead of failing this test; and 'exit' never fires after
  // it, so both waits below would otherwise sit out their full deadlines and blame the prompt for a
  // missing pty allocator.
  let spawnError: Error | undefined;
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, stdout }));
    child.once("error", (err) => {
      spawnError = err;
      resolve({ code: null, signal: null, stdout: `could not spawn python3 (pty allocator): ${err.message}` });
    });
  });

  const sawLine = async (line: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!stdout.includes(line) && spawnError === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    if (spawnError !== undefined) throw new Error(`could not spawn python3 (pty allocator): ${spawnError.message}`);
    if (!stdout.includes(line)) throw new Error(`child never printed ${JSON.stringify(line)}; got ${JSON.stringify(stdout)}`);
  };

  return { child, exited, sawLine };
}

// Windows has no pty to allocate — python's `pty` is POSIX-only — and its process.kill(pid,
// "SIGINT") terminates without running any listener — the same constraint every other cancellation
// case in this repo works under. Real execution is the WSL box and CI's ubuntu/macos legs; a green
// Windows run means this case SKIPPED.
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
      await sawLine("[a]lways");
      child.stdin?.write("\x03");
      // stdin is deliberately left open: an EOF on the pty master is its own way to close readline,
      // and it would end this run without the press ever being interpreted.

      // Raced against a named sentinel rather than plainly awaited, the same shape
      // tests/cli/cli.test.ts uses one file over. A regression here leaves the prompt parked
      // forever, and a bare await turns that into 60 s of CI, a leaked inner bun process behind
      // python3, and a red that says "timeout" rather than what actually broke.
      const settled = await Promise.race([
        exited,
        new Promise<"the prompt never settled">((r) => setTimeout(() => r("the prompt never settled"), 15_000)),
      ]);

      // Asserted on stdout rather than on the exit disposition, because the allocator reports its
      // own status and not the child's: pty.spawn's return value is discarded here, so python3
      // exits 0 however the inner bun died. Clause (b)'s by-signal death has its own test in
      // tests/signals.test.ts.
      expect(settled === "the prompt never settled" ? settled : settled.stdout).toContain("answer=no aborted=true");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // The only proof that the three-way parse works through a real tty in raw mode; a mocked
  // Interface cannot show it, because raw mode and readline's own line-editing are exactly what a
  // mock stands in for. One child for all three answers rather than three tests, because the pty
  // allocator spawn is the expensive part of every test in this file.
  test("typing a, n, and y at the prompt answers always, no, and once", async () => {
    const scriptPath = join(dir, "child-three.mjs");
    writeFileSync(scriptPath, childScriptThreeAnswers(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("[a]lways");
      await sawLine('"path":"a.txt"');
      child.stdin?.write("a\n");
      await sawLine("PROMPT answer=always");

      await sawLine('"path":"b.txt"');
      child.stdin?.write("n\n");
      await sawLine("PROMPT answer=no");

      await sawLine('"path":"c.txt"');
      child.stdin?.write("y\n");
      await sawLine("PROMPT answer=once");

      const settled = await Promise.race([
        exited,
        new Promise<"the prompt never settled">((r) => setTimeout(() => r("the prompt never settled"), 15_000)),
      ]);
      expect(settled === "the prompt never settled" ? settled : settled.code).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);
});
