import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// H-1/M-3: a session with no checkpoints at all, so `/undo 5` throws inside applyUndo — proving a
// command decision function's own exception is caught, not left to escape Ink's input handler.
// `/mode` sent afterward is what proves the process is still alive and responsive, not merely
// that it failed to crash outright. The turn resolves immediately (unlike the sibling scripts
// above, which hang on purpose) so `turnInFlight` clears before any command is sent — MEDIUM-3
// gates `/undo` while a turn is in flight, and this script tests `/undo`'s OWN throw, not that gate
// (which the dedicated MEDIUM-3 test below covers).
function childScriptCommandError(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "done", reason: "no-tool-call" };`,
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

// H-2: a runLoop that throws on its very first iteration, once Ink has already mounted — proving
// runTui's driveLoop().catch() path unmounts and rejects rather than leaving run() awaiting a
// promise that was never going to settle.
function childScriptRejects(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  throw new Error("boom");`,
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

// H-3: a runLoop that resolves per call, reporting how many times it has been invoked and how
// many messages it was handed — the two facts that prove a second, free-form task submission
// actually re-invoked driveLoop against the LIVE (accumulated) session, rather than the TUI
// exiting after the first turn or a second turn starting from a fresh/stale message list.
function childScriptMultiTurn(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls + " messages=" + opts.messages.length);`,
    `  yield { type: "messages-updated", messages: [...opts.messages, { role: "assistant", content: "ok " + calls }] };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
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

// HIGH-1: a turn that finishes and reports usage, then the TUI is left awaiting input — proving
// `run()` actually reaches `printUsage`/the exit-code logic on the TUI path once /exit or Ctrl-D
// resolves runTui's promise, which nothing did before this fix.
function childScriptQuit(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "usage", usage: { inputTokens: 12, outputTokens: 34 } };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `console.log("\\nEXIT_CODE " + code);`,
  ].join("\n");
}

// HIGH-B: parks mid-turn, after reporting real usage, waiting on the SAME abort signal
// childScriptCancel's fake runLoop waits on — proving /exit cancels an in-flight turn (via the
// same deliverSignal("SIGINT") path a single Ctrl-C already uses) rather than abandoning it.
function childScriptQuitMidTurn(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "usage", usage: { inputTokens: 12, outputTokens: 34 } };`,
    `  await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));`,
    `  console.log("\\nRUNLOOP_ABORTED aborted=" + opts.signal.aborted);`,
    `  yield { type: "done", reason: "aborted" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `console.log("\\nEXIT_CODE " + code);`,
  ].join("\n");
}

// MEDIUM-C: two clean turns, each reporting its own usage, proving the final summary (printed
// after /exit) sums every turn rather than just the last one.
function childScriptMultiTurnUsage(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `let calls = 0;`,
    `async function* runLoopFake(opts) {`,
    `  calls++;`,
    `  console.log("\\nRUNLOOP_CALL " + calls);`,
    `  yield { type: "usage", usage: { inputTokens: 10 * calls, outputTokens: 20 * calls } };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `const code = await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `});`,
    `console.log("\\nEXIT_CODE " + code);`,
  ].join("\n");
}

// LOW-4/MEDIUM-1: a still-in-flight turn that yields a SECOND messages-updated after a mid-turn
// /mode change — the exact shape of the regression MEDIUM-1 fixed. Pre-fix, driveLoop's own
// direct saveSession call on that second event used the turn-start (pre-/mode) session and
// clobbered the on-disk file back to the old mode; post-fix, driveLoop's persist callback is a
// no-op on the TUI path, so nothing but the reducer's own effect ever writes here. `flagPath`
// gates the second yield so the test can release it only once the FIRST write (the /mode
// command's own) is confirmed on disk.
//
// HIGH-A: round 3's version of this script waited for the transcript's own "(done: ...)" line
// before its one disk read — by which point the reducer's own onSessionChange effect for the
// SECOND messages-updated had already had its own chance to run and correct any stale write,
// regardless of whether one happened. Mutation-tested (the exact pre-fix stale saveSession call
// restored into driveLoop): that version stayed green. This version instead reads the session
// file SYNCHRONOUSLY, from inside this same process, as the very first statement once the
// generator resumes past the second yield — which is only after driveLoop's own synchronous
// persist()+dispatch() call for that event has already run, and (mutation-tested the same way,
// this time confirmed red before green below) before React's own effect scheduler has had a
// chance to flush the reducer's correction. `MODE_AT_RESUME` reports exactly what driveLoop's own
// synchronous work left on disk at that instant, not what it eventually settles to.
function childScriptModePersistence(dir: string, flagPath: string): string {
  const sessionsDir = join(dir, "sessions");
  return [
    `import { existsSync, readFileSync, readdirSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "messages-updated", messages: opts.messages };`,
    `  console.log("\\nRUNLOOP_MSG1");`,
    `  await new Promise((resolve) => {`,
    `    const check = () => { if (existsSync(${JSON.stringify(flagPath)})) resolve(); else setTimeout(check, 20); };`,
    `    check();`,
    `  });`,
    `  yield { type: "messages-updated", messages: opts.messages };`,
    `  const sessionFile = readdirSync(${JSON.stringify(sessionsDir)}).find((f) => f.endsWith(".json"));`,
    `  const modeAtResume = JSON.parse(readFileSync(join(${JSON.stringify(sessionsDir)}, sessionFile), "utf8")).permissionMode;`,
    `  console.log("\\nMODE_AT_RESUME " + modeAtResume);`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(sessionsDir)},`,
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
  // MEDIUM-C: the transcript prints the identical "(done: no-tool-call)" line for every turn in a
  // multi-turn session, so `sawLine` (a plain substring check) is already true for turn 2's own
  // occurrence the instant turn 1's happens — this counts occurrences instead, so a caller can
  // wait for the SECOND (or Nth) one specifically rather than racing turn 2's own completion
  // against an assertion that turn 1 alone already satisfies.
  sawLineTimes: (line: string, count: number) => Promise<void>;
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

  const occurrences = (line: string): number => stdout.split(line).length - 1;

  const sawLine = async (line: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!stdout.includes(line) && spawnError === undefined && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    if (spawnError !== undefined)
      throw new Error(`could not spawn python3 (pty allocator): ${spawnError.message}`);
    if (!stdout.includes(line))
      throw new Error(`child never printed ${JSON.stringify(line)}; got ${JSON.stringify(stdout)}`);
  };

  const sawLineTimes = async (line: string, count: number): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (occurrences(line) < count && spawnError === undefined && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    if (spawnError !== undefined)
      throw new Error(`could not spawn python3 (pty allocator): ${spawnError.message}`);
    if (occurrences(line) < count)
      throw new Error(
        `child printed ${JSON.stringify(line)} ${occurrences(line)} time(s), wanted ${count}; got ${JSON.stringify(stdout)}`,
      );
  };

  return { child, exited, sawLine, sawLineTimes };
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
  // dropped), different route to signals.ts: there is no readline Interface in the TUI path, so
  // this exercises App.tsx's own onCancel handler and runTui's exitOnCtrlC: false instead (Ink's
  // default exitOnCtrlC would otherwise unmount the app on the same press, competing with the
  // cancel this asserts on).
  //
  // Asserted on stdout, not on the process exiting: H-3's multi-turn wiring means a cancelled turn
  // returns the TUI to "awaiting input" rather than ending the process (only a fatal Ctrl-C does
  // that — see the "second Ctrl-C" test below). Confirmed for real on a pty (WSL2) that the
  // process does NOT exit here: driveLoop resolves, runTurn's `finally` clears turnInFlight, and
  // the process sits waiting for more input until the harness kills it in `finally` — an earlier
  // version of this test raced `exited` instead and hung for the full timeout every time, which is
  // what this comment now documents rather than an assertion that stopped matching H-3's own
  // behavior.
  test("a single Ctrl-C during an Ink-driven run cancels the turn instead of killing the process outright", async () => {
    const scriptPath = join(dir, "child-cancel.mjs");
    writeFileSync(scriptPath, childScriptCancel(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
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
      await sawLine("RUNLOOP_ABORTED aborted=true");
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

  // H-1 + M-3: a command decision function throwing (no checkpoints to /undo to) used to escape
  // straight out of Ink's own input handler. Confirmed here two ways — the error is shown, not
  // silently dropped, AND the process is still alive and answers a second, unrelated command
  // afterward, which a crash would not. M-3's other case — input shaped like a slash command that
  // matches nothing at all (a typo) — is checked in the same run, since it needs the same fixture.
  test("a slash command that throws, or one that matches nothing, shows an error line instead of crashing the TUI", async () => {
    const scriptPath = join(dir, "child-command-error.mjs");
    writeFileSync(scriptPath, childScriptCommandError(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      // Turn resolves right away (this script's own comment explains why) — waited for here so
      // `/undo 5` below exercises applyUndo's own throw, not MEDIUM-3's turn-in-flight gate.
      await sawLine("(done: no-tool-call)");

      // M-3: a typo'd command name matches nothing in SLASH_COMMANDS at all.
      child.stdin?.write("/mdoe");
      await sawLine("/mdoe");
      child.stdin?.write("\r");
      await sawLine("Unrecognized command: /mdoe");

      // H-1: a name that DOES match, but throws inside its own decision function.
      child.stdin?.write("/undo 5");
      await sawLine("/undo 5");
      child.stdin?.write("\r");
      await sawLine("checkpoint(s) to undo to; asked for 5");

      // Still alive: an ordinary command sent right after both of the above still works.
      // cycleMode (gate/gate.ts) cycles approve-each -> auto -> read-only -> approve-each, and a
      // fresh session starts at approve-each (the [approve-each] indicator shown on mount), so
      // this first /mode press lands on auto, not read-only.
      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // MEDIUM-D: "/exit the debugger and retry" is a task whose first word happens to be /exit, not
  // a request to quit — used to be hijacked into one regardless of the trailing words. Confirmed
  // two ways: the error is shown (not a silent quit), and the process is still alive and answers
  // an unrelated command afterward, which quitting would not.
  test("/exit with trailing arguments is rejected rather than quitting the TUI", async () => {
    const scriptPath = join(dir, "child-exit-hijack.mjs");
    writeFileSync(scriptPath, childScriptCommandError(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("/exit the debugger and retry");
      await sawLine("/exit the debugger and retry");
      child.stdin?.write("\r");
      await sawLine("/exit: invalid arguments.");

      // Still alive — quitting would leave nothing to answer this.
      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // H-2: driveLoop rejecting (a real throw, not just an aborted/errored `done` event) is a
  // distinct failure mode from every other exit this file tests — runTui's own catch has to
  // unmount and reject rather than leave run()'s own `await runTui(...)` parked forever. Asserted
  // by the child process actually exiting within the deadline rather than hanging; run() has no
  // try/catch of its own around that await (matching the non-interactive path's own documented
  // behavior for a throw escaping driveLoop's for-await), so this surfaces as the child process
  // itself ending, one way or another, not as a value run() returns.
  test("driveLoop rejecting settles run() instead of hanging forever", async () => {
    const scriptPath = join(dir, "child-rejects.mjs");
    writeFileSync(scriptPath, childScriptRejects(dir));

    const { exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      const settled = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(settled).not.toBe("the run never settled");
    } finally {
      // Already exited in the success case; harmless if the process is already gone.
    }
  }, 60_000);

  // H-3: submitting free-form text (not a recognised slash command) after the first turn
  // completes starts a SECOND driveLoop call against the live, accumulated session, and the TUI
  // does not exit between the two turns — feature-plan.md's own acceptance criterion ("the next
  // model turn reads" a live-updated session), demonstrated with a real second turn rather than
  // just the reducer merge C-1 already covers.
  test("a second, free-form task submission starts another turn against the accumulated session", async () => {
    const scriptPath = join(dir, "child-multi-turn.mjs");
    writeFileSync(scriptPath, childScriptMultiTurn(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      // prepareSession appended the initial task as the session's only message.
      await sawLine("RUNLOOP_CALL 1 messages=1");
      // Turn 1's own "done" — not "ok 1" (the fake runLoop's assistant reply content): that lives
      // only in session.messages via the reducer's messages-updated merge, never rendered to the
      // transcript, the same as a real model reply's own content is never echoed back by
      // messages-updated (tui/reducer.ts's own case, and printEvent's identical no-op for the
      // non-interactive path). Waiting for "done" here is what actually matters: it is only
      // dispatched after driveLoop's own for-await loop has fully returned, so by the time it
      // appears, turnInFlight has cleared (the input box will accept a new submission) and
      // onSessionChange has already run for turn 1's own messages-updated (its dispatch strictly
      // precedes "done"'s in the same driveLoop call), so liveSession already carries the turn-1
      // assistant reply before task 2 is submitted.
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("a second task");
      // Reflected live in the input box's own rendered frame first, same as the raw-mode-input
      // test above — sending "\r" immediately after, with no wait for the text to actually land,
      // measured (on a real pty) to lose the Enter press entirely: the box was left showing "a
      // second task" unsubmitted and no second driveLoop call ever happened, this test hanging to
      // its own timeout every time. Root cause not further isolated beyond that reproduction; the
      // fix is the same one every other input-driven test in this file already applies.
      await sawLine("a second task");
      child.stdin?.write("\r");

      // 1 initial + 1 turn-1 assistant reply + 1 new user message = 3, and the app is still
      // running to report it at all — proof it did not exit after the first turn.
      await sawLine("RUNLOOP_CALL 2 messages=3");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // H-4 (the fatal path M-2's terminal-state fix guards): a second Ctrl-C, once the first has
  // already spent signals.ts's one cancel slot, is fatal rather than a second cancel — the same
  // "one slot, second press finds it empty" mechanism as everywhere else in this repo (see
  // signals.ts's own deliverSignal comment), reached here via App.tsx's onCancel instead of a
  // readline Interface. Asserted the same way tests/signals.test.ts's own "a second press skips
  // the unwind and still exits by signal" test is: the process actually terminates rather than
  // hanging, which is what M-2's onSignalCleanup(() => instance.unmount()) exists to make happen
  // cleanly (restoring raw mode) rather than leaving the terminal in whatever state a bare
  // process.kill mid-render left it in — not independently checkable from outside the dying
  // process on this pty harness, so this is the process-terminates half of that fix; the
  // terminal's own visual state is Phase 7's to confirm on a real terminal.
  test("a second Ctrl-C after the first is spent terminates the process instead of hanging", async () => {
    const scriptPath = join(dir, "child-cancel.mjs");
    writeFileSync(scriptPath, childScriptCancel(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      child.stdin?.write("\x03");
      await sawLine("RUNLOOP_ABORTED aborted=true");
      // The first press's cancel slot is now spent, and nothing re-registers one between turns
      // (runTui does not call driveLoop again until another task is submitted) — so this second
      // press finds the slot empty and falls straight through to signals.ts's fatal path.
      child.stdin?.write("\x03");

      const settled = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(settled).not.toBe("the run never settled");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // HIGH-1: before this fix, runTui's own promise only ever rejected — a turn finishing normally
  // left `run()`'s `await runTui(...)` parked forever, so printUsage/the exit-code logic were dead
  // code on the TUI path. /exit is the new graceful-quit affordance: submitted once the turn is
  // done (turnInFlight has cleared), it should unmount Ink, resolve run() with a real exit code
  // (0, since doneReason is "no-tool-call" and nothing was refused), and print the same
  // token/cost summary line the non-interactive path prints via printUsage.
  test("submitting /exit after a turn completes resolves run() with a normal exit code and a final usage summary", async () => {
    const scriptPath = join(dir, "child-quit.mjs");
    writeFileSync(scriptPath, childScriptQuit(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("/exit");
      await sawLine("/exit");
      child.stdin?.write("\r");

      const result = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(result).not.toBe("the run never settled");
      // Asserted on stdout's own EXIT_CODE line, not `result.code` — same reason
      // tests/cli/approvalPromptPty.test.ts's own comment gives: the pty allocator (python3)
      // reports its own exit status, not the grandchild bun process's, so `result.code` is
      // always 0 regardless of what run() actually returned.
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 0");
      // printUsage's own line shape (cli/output.ts) — proof it actually ran, not just that the
      // process happened to exit 0 some other way.
      expect(stdout).toContain("(tokens: 12 in, 34 out)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // MEDIUM-C: Ctrl-D's own trigger for the same quit path /exit uses — a clone of the test above
  // with \x04 (Ctrl-D) in place of typing "/exit" and pressing Enter.
  test("Ctrl-D at the input box quits the same way /exit does", async () => {
    const scriptPath = join(dir, "child-quit-ctrld.mjs");
    writeFileSync(scriptPath, childScriptQuit(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("\x04");

      const result = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(result).not.toBe("the run never settled");
      // Asserted on stdout's own EXIT_CODE line — childScriptQuit's own sibling test above
      // explains why `result.code` itself is not the right thing to check here.
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 0");
      expect(stdout).toContain("(tokens: 12 in, 34 out)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // HIGH-B: /exit while a turn is in flight used to abandon it outright — controller.abort() was
  // never called, the turn's own usage was never folded into the final summary, and runTui's
  // promise never resolved at all (turnInFlight only clears in runTurn's own finally, which
  // abandoning the turn never triggered), so run() hung forever instead of settling. Mutation-
  // tested against the pre-fix quit() (no turnInFlight check at all): this test hung on the
  // RUNLOOP_ABORTED wait below until its own 60s timeout, every time — confirmed red before this
  // fix, confirmed green after.
  test("submitting /exit while a turn is in flight cancels it gracefully instead of abandoning it (HIGH-B)", async () => {
    const scriptPath = join(dir, "child-quit-mid-turn.mjs");
    writeFileSync(scriptPath, childScriptQuitMidTurn(dir));

    const { child, exited, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/exit");
      await sawLine("/exit");
      child.stdin?.write("\r");

      // The discriminating assertion: pre-fix, quit() never touched turnInFlight or
      // cancellation, so controller.abort() was never called, the fake runLoop's own abort
      // listener never fired, and this line never appeared.
      await sawLine("RUNLOOP_ABORTED aborted=true");

      const result = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(result).not.toBe("the run never settled");
      // Asserted on stdout's own EXIT_CODE line — childScriptQuit's own sibling test explains why
      // `result.code` itself is not the right thing to check here. The turn was cancelled, not
      // completed — doneReason is "aborted", the same exit code an aborted turn gets from every
      // other path (run()'s own documented contract): `seri "…" && next` must not run `next` off
      // the back of a task /exit cut short, so this is 1, not the clean-quit test's own 0.
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 1");
      // The turn's own usage (spent before it was cancelled) still made it into the final
      // summary — proof runTurn's usage-folding ran (and quit() waited for it) before resolving,
      // not that the process just happened to exit some other way.
      expect(stdout).toContain("(tokens: 12 in, 34 out)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // MEDIUM-C: a second turn with its own usage — the final summary must sum both, not report only
  // the last turn's, which addTokens/runTui's own accumulation (cli.ts) claims but had no test.
  test("a multi-turn session's final usage summary sums every turn's tokens, not just the last one", async () => {
    const scriptPath = join(dir, "child-multi-turn-usage.mjs");
    writeFileSync(scriptPath, childScriptMultiTurnUsage(dir));

    const { child, exited, sawLine, sawLineTimes } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_CALL 1");
      await sawLine("(done: no-tool-call)");

      child.stdin?.write("a second task");
      await sawLine("a second task");
      child.stdin?.write("\r");
      await sawLine("RUNLOOP_CALL 2");
      // The SECOND occurrence specifically — the plain sawLine above is already true from turn
      // 1's own, and sending /exit before turn 2's driveLoop call has actually returned would
      // race turnInFlight instead of testing what this test is about.
      await sawLineTimes("(done: no-tool-call)", 2);

      child.stdin?.write("/exit");
      await sawLine("/exit");
      child.stdin?.write("\r");

      const result = await Promise.race([
        exited,
        new Promise<"the run never settled">((r) =>
          setTimeout(() => r("the run never settled"), 15_000),
        ),
      ]);

      expect(result).not.toBe("the run never settled");
      // Asserted on stdout's own EXIT_CODE line — childScriptQuit's own sibling test explains why
      // `result.code` itself is not the right thing to check here.
      const { stdout } = result as Exit;
      expect(stdout).toContain("EXIT_CODE 0");
      // Turn 1: 10 in, 20 out. Turn 2: 20 in, 40 out. Summed: 30 in, 60 out — not turn 2's own
      // 20/40 alone.
      expect(stdout).toContain("(tokens: 30 in, 60 out)");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // MEDIUM-3: /undo, /restore and /rewind are gated while a turn is in flight (a mid-turn
  // /rewind would truncate session.messages only for the still-running turn's own next
  // messages-updated to replace the whole array wholesale, erasing the truncation) — /mode is
  // deliberately NOT gated, and this test confirms that difference rather than just the block.
  test("/rewind is blocked while a turn is in flight, but /mode still works (MEDIUM-3)", async () => {
    const scriptPath = join(dir, "child-turn-in-flight-gate.mjs");
    writeFileSync(scriptPath, childScriptInput(dir));

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");

      child.stdin?.write("/rewind 1");
      await sawLine("/rewind 1");
      child.stdin?.write("\r");
      await sawLine("/rewind: can't run while a turn is in flight.");

      // Still alive, and /mode (deliberately ungated) still works — proof the block above is
      // specific to /rewind, not the input box wedged or the whole command path broken.
      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  // LOW-4/MEDIUM-1: the disk-level regression test that should have existed to catch MEDIUM-1 in
  // the first place — the existing reducer-unit test only checks in-memory state, which the old,
  // buggy code also got right eventually; the bug was specifically about what landed on disk in
  // between. Asserts the on-disk session file directly, not the transcript or reducer state.
  test("a mid-turn /mode change is on disk immediately and a still-running turn's later write does not revert it", async () => {
    const flagPath = join(dir, "release-turn");
    const scriptPath = join(dir, "child-mode-persist.mjs");
    writeFileSync(scriptPath, childScriptModePersistence(dir, flagPath));
    const sessionsDir = join(dir, "sessions");

    const { child, sawLine } = startChild(scriptPath, dir);
    try {
      await sawLine("RUNLOOP_READY");
      await sawLine("RUNLOOP_MSG1");

      child.stdin?.write("/mode");
      await sawLine("/mode");
      child.stdin?.write("\r");
      await sawLine("permission mode is now auto");

      const sessionFile = readdirSync(sessionsDir).find((f) => f.endsWith(".json"));
      if (sessionFile === undefined) throw new Error("no session file written yet");
      const sessionPath = join(sessionsDir, sessionFile);

      // Polled, not asserted immediately: the write happens in App.tsx's own onSessionChange
      // effect, which fires after the dispatch above, not synchronously with the keypress.
      const deadline = Date.now() + 5_000;
      let mode: string;
      do {
        mode = JSON.parse(readFileSync(sessionPath, "utf8")).permissionMode;
      } while (mode !== "auto" && Date.now() < deadline);
      expect(mode).toBe("auto");

      // Release the still-in-flight turn's second messages-updated. Pre-MEDIUM-1-fix, driveLoop's
      // own direct saveSession call here used the turn-start (pre-/mode) session and clobbered
      // the file above back to "approve-each" — for the narrow window before the reducer's own
      // effect corrected it again. HIGH-A: the child script's own MODE_AT_RESUME marker (its own
      // comment explains why) is what actually observes that window; waiting for a later line in
      // the transcript, like the old version of this test did, does not.
      writeFileSync(flagPath, "");
      await sawLine("MODE_AT_RESUME auto");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);
});
