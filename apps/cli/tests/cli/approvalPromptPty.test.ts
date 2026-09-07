import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

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
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

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
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// Node readline Ctrl-D closes the interface without ending the stream.
function childScriptCtrlD(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  const a = await opts.approvalPrompt("write_file", { path: "a.txt" }, opts.signal);`,
    `  console.log("\\nPROMPT answer=" + a);`,
    `  const b = await opts.approvalPrompt("write_file", { path: "b.txt" }, opts.signal);`,
    `  console.log("\\nPROMPT answer=" + b);`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["write", "hello.txt"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

// python3 stdlib pty allocates a real tty; a pipe cannot deliver 0x03 as a keypress.
function startChild(
  scriptPath: string,
  cwd: string,
): {
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

  // Node spawn reports a missing python3 as an error event, not a throw.
  let spawnError: Error | undefined;
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, stdout }));
    child.once("error", (err) => {
      spawnError = err;
      resolve({
        code: null,
        signal: null,
        stdout: `could not spawn python3 (pty allocator): ${err.message}`,
      });
    });
  });

  const sawLine = async (line: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!stdout.includes(line) && spawnError === undefined && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    if (spawnError !== undefined)
      throw new Error(`could not spawn python3 (pty allocator): ${spawnError.message}`);
    if (!stdout.includes(line))
      throw new Error(`child never printed ${JSON.stringify(line)}; got ${JSON.stringify(stdout)}`);
  };

  return { child, exited, sawLine };
}

// Windows has no pty to allocate — python pty is POSIX-only.
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
      // Node readline in raw mode eats 0x03 and does not raise SIGINT.
      await sawLine("[a]lways");
      child.stdin?.write("\x03");

      const settled = await Promise.race([
        exited,
        new Promise<"the prompt never settled">((r) =>
          setTimeout(() => r("the prompt never settled"), 15_000),
        ),
      ]);

      expect(settled === "the prompt never settled" ? settled : settled.stdout).toContain(
        "answer=no aborted=true",
      );
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("typing a, n, and y at the prompt answers always, no, and once", async () => {
    const scriptPath = join(dir, "child-three.mjs");
    writeFileSync(scriptPath, childScriptThreeAnswers(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("[a]lways");
      await sawLine("saved for this project");
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
        new Promise<"the prompt never settled">((r) =>
          setTimeout(() => r("the prompt never settled"), 15_000),
        ),
      ]);
      expect(settled === "the prompt never settled" ? settled : settled.code).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // Node readline Ctrl-D closes the interface without ending the stream.
  test("Ctrl-D at one prompt does not deny every prompt after it", async () => {
    const scriptPath = join(dir, "child-ctrl-d.mjs");
    writeFileSync(scriptPath, childScriptCtrlD(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine('"path":"a.txt"');
      child.stdin?.write("\x04");
      await sawLine("PROMPT answer=no");

      await sawLine('"path":"b.txt"');
      child.stdin?.write("y\n");
      await sawLine("PROMPT answer=once");

      const settled = await Promise.race([
        exited,
        new Promise<"the prompt never settled">((r) =>
          setTimeout(() => r("the prompt never settled"), 15_000),
        ),
      ]);
      expect(settled === "the prompt never settled" ? settled : settled.code).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);
});
