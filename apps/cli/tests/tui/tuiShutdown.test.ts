// Regression for anomalyco/opentui#1355: Ctrl-D on a real pty must fully reap the process.
import { afterEach, beforeEach, describe, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SPLASH_MARK } from "./helpers";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

// Uses production process.exit(); opentui#1355 is invisible if the child exits naturally.
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

// CliRenderer installs a log-only uncaughtException handler; this throw is a bare setTimeout so it is a real process-level exception.
function childScriptUncaughtException(dir: string): string {
  const trigger = join(dir, "throw-now");
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `console.log("\\nCHILD_PID " + process.pid);`,
    `const { existsSync } = await import("node:fs");`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `cli.run(["do", "a", "task"], {`,
    `  runLoop: runLoopFake,`,
    `  getGroqModel: () => ({}),`,
    `  loadAgentsFile: () => "",`,
    `  isTTY: process.stdout.isTTY,`,
    `  sessionsDir: ${JSON.stringify(join(dir, "sessions"))},`,
    `  checkpointsDir: ${JSON.stringify(join(dir, "checkpoints"))},`,
    `  permissionsDir: ${JSON.stringify(join(dir, "config"))},`,
    `}).then((code) => process.exit(code));`,
    // Arm the throw after "done ·" so createCliRenderer's log-only handler is not the only listener.
    `const trigger = ${JSON.stringify(trigger)};`,
    `setInterval(() => { if (existsSync(trigger)) throw new Error("INJECTED_UNCAUGHT_TEST_ERROR"); }, 50);`,
  ].join("\n");
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };

// python3 pty: raw mode and Ctrl-D-as-a-keypress need a real tty, not a pipe.
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

  await sawLine(SPLASH_MARK);
  child.stdin?.write("\x1b");
  await new Promise((r) => setTimeout(r, 100));

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

// ps -p <pid> -o pcpu= works on GNU and BSD CI; /proc is Linux-only.
function readCpuPercent(pid: number): number | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pcpu="]);
  if (result.error || result.status !== 0) return null;
  const value = Number.parseFloat(result.stdout.toString().trim());
  return Number.isNaN(value) ? null : value;
}

// Windows has no pty to allocate.
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
        if (!match) throw new Error(`could not find CHILD_PID in ${JSON.stringify(stdoutSoFar())}`);
        childPid = Number.parseInt(match[1], 10);

        // OpenTUI intercepts console.log and can skip the space before "done ·" in cell-diff; wait on that transcript line, not RUNLOOP_READY.
        await sawLine("done ·");

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

        // Brief OS reap window; isProcessAlive (kill pid, 0 / ESRCH) is the assertion.
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
        if (childPid !== undefined && isProcessAlive(childPid)) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {}
        }
      }
    }, 30_000);
  },
);

describe.skipIf(process.platform === "win32")(
  "an uncaught exception during an interactive session still crashes the process",
  () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "seri-tui-uncaught-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("a background throw unrelated to the renderer exits the process instead of being silently swallowed", async () => {
      const scriptPath = join(dir, "child-uncaught.mjs");
      writeFileSync(scriptPath, childScriptUncaughtException(dir));

      const { child, exited, sawLine, stdoutSoFar } = await startChild(scriptPath, dir);
      let childPid: number | undefined;
      try {
        await sawLine("CHILD_PID ");
        const match = stdoutSoFar().match(/CHILD_PID (\d+)/);
        if (!match) throw new Error(`could not find CHILD_PID in ${JSON.stringify(stdoutSoFar())}`);
        childPid = Number.parseInt(match[1], 10);

        await sawLine("done ·");
        writeFileSync(join(dir, "throw-now"), "");

        // python3's pty.spawn does not propagate the bun child's exit status; isProcessAlive(childPid) does.
        const exitResult = await Promise.race([
          exited,
          new Promise<"the process never exited">((r) =>
            setTimeout(() => r("the process never exited"), 20_000),
          ),
        ]);
        if (exitResult === "the process never exited") {
          throw new Error(
            `child never exited after its own injected uncaughtException -- ` +
              `@opentui/core's own handler (which only logs) swallowed it instead of ` +
              `runtime/renderer.ts's own handler taking over; got ${JSON.stringify(stdoutSoFar())}`,
          );
        }

        await new Promise((r) => setTimeout(r, 500));
        if (isProcessAlive(childPid)) {
          throw new Error(
            `pid ${childPid} is still running after its own injected uncaughtException -- ` +
              `@opentui/core's own handler (which only logs) swallowed it instead of ` +
              `runtime/renderer.ts's own handler taking over`,
          );
        }
      } finally {
        try {
          child.kill();
        } catch {}
        if (childPid !== undefined && isProcessAlive(childPid)) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {}
        }
      }
    }, 30_000);
  },
);
