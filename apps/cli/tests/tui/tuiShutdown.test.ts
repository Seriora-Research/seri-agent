// Shutdown-path regression test for anomalyco/opentui#1355 (an OpenTUI exit handler that can
// leave an orphaned, 100%-CPU process running after shutdown). Drives the REAL seri binary
// through a normal Ctrl-D quit on a real pty and asserts the process is fully gone afterward --
// a unit-level mock of the renderer's `destroy()` call would prove nothing here, since the bug
// this guards against is a process-lifecycle property, not a return-value contract.
import { afterEach, beforeEach, describe, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

// Mirrors cli.ts's own module-level shutdown call (`run(...).then((code) => process.exit(code))`)
// rather than the diagnostic-only "EXIT_CODE" console.log convention tuiPty.test.ts's own
// childScript* fixtures use elsewhere in this test area: opentui#1355 can only be observed against
// the SAME explicit `process.exit()` production actually takes on quit -- skipping it would leave
// the process to exit naturally instead, testing a shutdown path production never uses.
function childScriptQuitAndExit(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `console.log("\\nCHILD_PID " + process.pid);`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
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
    `process.exit(code);`,
  ].join("\n");
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };

// Lean variant of tuiPty.test.ts's own startChild (same python3-pty technique, same reason a pty
// is load-bearing -- raw mode and Ctrl-D-as-a-keypress both need a real tty, not a pipe):
// duplicated rather than imported, matching this repo's convention of self-contained pty test
// files, but trimmed to only what this file's single test needs.
async function startChild(scriptPath: string, cwd: string) {
  const args = ["-c", "import pty, sys; pty.spawn(sys.argv[1:])", process.execPath, scriptPath];
  const child = spawn("python3", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });

  let spawnError: Error | undefined;
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (err) => {
      spawnError = err;
      resolve({ code: null, signal: null });
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

  // The welcome splash mounts ahead of the normal flow on every interactive launch (same as every
  // other childScript* fixture in tuiPty.test.ts) -- dismissed here the same way its own startChild
  // does: wait for the splash's wordmark, write Escape, then a settle margin.
  try {
    await sawLine("SERI");
    child.stdin?.write("\x1b");
    await new Promise((r) => setTimeout(r, 100));
  } catch {}

  return { child, exited, sawLine, stdoutSoFar: () => stdout };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Best-effort diagnostic only, never load-bearing for pass/fail: `ps -p <pid> -o pcpu=` is
// supported by both GNU (Linux CI) and BSD (macOS CI) `ps`, unlike /proc parsing which is
// Linux-only.
function readCpuPercent(pid: number): number | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pcpu="]);
  if (result.error || result.status !== 0) return null;
  const value = Number.parseFloat(result.stdout.toString().trim());
  return Number.isNaN(value) ? null : value;
}

// Real execution is the WSL box and CI's ubuntu/macos legs, same constraint tuiPty.test.ts's own
// describe block documents -- Windows has no pty to allocate.
describe.skipIf(process.platform === "win32")(
  "TUI shutdown leaves no orphaned process (opentui#1355)",
  () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "seri-tui-shutdown-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("a normal Ctrl-D quit fully terminates the process, no orphan left running", async () => {
      const scriptPath = join(dir, "child-shutdown.mjs");
      writeFileSync(scriptPath, childScriptQuitAndExit(dir));

      const { child, exited, sawLine, stdoutSoFar } = await startChild(scriptPath, dir);
      let childPid: number | undefined;
      try {
        await sawLine("CHILD_PID ");
        const match = stdoutSoFar().match(/CHILD_PID (\d+)/);
        if (!match)
          throw new Error(`could not find CHILD_PID in ${JSON.stringify(stdoutSoFar())}`);
        childPid = Number.parseInt(match[1], 10);

        // startChild already dismissed the welcome splash above. "no-tool-call)" is reducer-driven
        // transcript content (reducer.ts's own `pushLine("(done: ${reason})")`, rendered as a real
        // `<text>` element), not a bare `console.log` -- OpenTUI's renderer intercepts `console.log`
        // into its own hidden debug overlay by default (`TerminalConsoleCache.overrideConsoleMethods`
        // in @opentui/core), so a synthetic marker printed via `console.log` (the convention
        // tuiPty.test.ts's own childScript* fixtures use, e.g. "RUNLOOP_READY") no longer reaches the
        // real pty output the way it did under Ink -- confirmed live against this exact fixture and,
        // separately, against an existing unmodified tuiPty.test.ts test, so this is not specific to
        // this file. A single hyphenated token, not the full "(done: no-tool-call)" string: OpenTUI's
        // own incremental cell-diff redraw can split one logical line's raw bytes across more than
        // one write (an unchanged space cell between "(done:" and "no-tool-call)" was skipped rather
        // than re-emitted, breaking a contiguous match on the two-word form) -- measured directly
        // against this exact capture, not assumed.
        await sawLine("no-tool-call)");

        // Ctrl-D, the same graceful-quit affordance tuiPty.test.ts's own "Ctrl-D at the input box
        // quits the same way /exit does" test uses.
        child.stdin?.write("\x04");

        const exitResult = await Promise.race([
          exited,
          new Promise<"the run never settled">((r) =>
            setTimeout(() => r("the run never settled"), 20_000),
          ),
        ]);
        if (exitResult === "the run never settled") {
          throw new Error(
            `child never exited after Ctrl-D (opentui#1355's own hang symptom -- process.exit() ` +
              `was never reached); got ${JSON.stringify(stdoutSoFar())}`,
          );
        }

        // A short grace window for the OS to finish reaping the exited process -- `isProcessAlive`
        // (backed by `process.kill(pid, 0)`'s ESRCH) is what actually confirms it, not this delay
        // alone.
        await new Promise((r) => setTimeout(r, 500));

        if (isProcessAlive(childPid)) {
          const cpu = readCpuPercent(childPid);
          throw new Error(
            `pid ${childPid} is still running${cpu !== null ? ` (${cpu}% CPU)` : ""} after a ` +
              `clean Ctrl-D quit -- this is opentui#1355's orphaned-process failure mode`,
          );
        }
      } finally {
        try {
          child.kill();
        } catch {}
        // Belt-and-suspenders, same reasoning tuiPtyWindows.test.ts's own killOrphansByScriptPath
        // documents: if the assertion above already found a live orphan, don't also leave it
        // running past this test.
        if (childPid !== undefined && isProcessAlive(childPid)) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {}
        }
      }
    }, 30_000);
  },
);
