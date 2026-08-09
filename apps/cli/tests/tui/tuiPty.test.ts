import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

// The real cli.ts, same reason as tests/cli/approvalPromptPty.test.ts: `isTTY` has to come from a
// REAL process.stdout.isTTY on a real pty (the fix this session made to cli.ts requires it be
// passed explicitly — see CliDeps.isTTY's own comment — and a fake `true` would prove nothing about
// whether Ink's raw-mode input actually works). The fake runLoop waits on the AbortSignal rather
// than resolving on its own, so the turn is still "in flight" — and the TUI still mounted — when
// the Ctrl-C arrives.
function childScriptCancel(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));`,
    `  console.log("\\nRUNLOOP_ABORTED aborted=" + opts.signal.aborted);`,
    `  yield { type: "done", reason: "aborted" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

// A runLoop that never settles, so the TUI stays mounted and interactive for as long as the test
// needs to type into it — nothing here is about the loop finishing, only about the input box and
// the slash-command dispatch wired in Phase 5.
function childScriptInput(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  await new Promise(() => {});`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
  ].join("\n");
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

// Identical shape to tests/cli/approvalPromptPty.test.ts's own startChild — duplicated rather than
// imported, matching this repo's convention of self-contained pty test files. See that file's own
// comment for why a pty (not a pipe) is load-bearing here: raw mode's interpretation of input —
// both 0x03 as a keypress rather than a signal, and each typed character reflecting live — is the
// entire mechanism under test, and a pipe cannot exercise either.
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

// Windows has no pty to allocate — same constraint as approvalPromptPty.test.ts. Real execution is
// the WSL box and CI's ubuntu/macos legs; a green Windows run means this case SKIPPED.
describe.skipIf(process.platform === "win32")("the Ink TUI on a real terminal", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seri-pty-tui-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The TUI counterpart of approvalPromptPty.test.ts's "a real Ctrl-C at the prompt cancels the
  // turn" test — same fact (a single press cancels the in-flight turn rather than being silently
  // dropped or killing the process outright), different route to signals.ts: there is no readline
  // Interface in the TUI path, so this exercises App.tsx's own onCancel handler and runTui's
  // exitOnCtrlC: false instead (this session's own fix, added while writing this test — Ink's
  // default exitOnCtrlC would otherwise unmount the app on the same press, competing with the
  // cancel this asserts on).
  test("a single Ctrl-C during an Ink-driven run cancels the turn instead of killing the process outright", async () => {
    const scriptPath = join(dir, "child-cancel.mjs");
    writeFileSync(scriptPath, childScriptCancel(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      // Waiting for the fake runLoop's own readiness line is also what keeps the byte out of the
      // window before Ink sets raw mode (useInput's mount effect calls setRawMode(true)) — driveLoop
      // only reaches runLoopFake after runTui's connectDispatch effect has already fired, which is
      // after every mount effect from that same commit, useInput's included, has already run. While
      // the pty is still canonical, 0x03 would raise a real SIGINT and the test would pass for the
      // wrong reason — same reasoning as approvalPromptPty.test.ts's own "[a]lways" wait.
      await sawLine("RUNLOOP_READY");
      child.stdin?.write("\x03");
      // stdin is deliberately left open, same reason as the sibling file: an EOF would end the run
      // its own way, before the press is ever interpreted.

      const settled = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(settled === "the run never settled" ? settled : settled.stdout).toContain(
        "RUNLOOP_ABORTED aborted=true",
      );
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // Raw-mode multiline input, smoke-level: a slash command typed character-by-character into
  // Phase 4's input box is reflected live (proving raw mode, not readline's line-buffered cooked
  // mode, is what is driving this), and Enter submits it through Phase 5's decision/presentation
  // wiring — the same tuiPresenter path /mode, /undo, /restore and /rewind all share. Enter is "\r"
  // (carriage return), not "\n": Ink's own parse-keypress.js maps "\r" to key.name "return" (what
  // InputBox's `key.return` check reads) and "\n" to a different name, "enter", which InputBox does
  // not recognise — the raw-mode counterpart of readline's own "\n"-terminated convention used
  // elsewhere in this repo's pty tests, not a typo.
  test("typing a slash command into the input box, then Enter, dispatches it through the Phase 5 wiring", async () => {
    const scriptPath = join(dir, "child-input.mjs");
    writeFileSync(scriptPath, childScriptInput(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/mode");
      // Reflected live in the input box's own rendered frame — proof raw mode is actually driving
      // this, not just that the command eventually took effect.
      await sawLine("/mode");

      child.stdin?.write("\r");
      // applyModeCycle (tui/commands.ts, Phase 2) cycling a fresh session's default
      // permissionMode ("approve-each") one step, dispatched into the transcript by tuiPresenter
      // (Phase 5) rather than console.log'd — this line only appears if that whole chain ran.
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);
});
