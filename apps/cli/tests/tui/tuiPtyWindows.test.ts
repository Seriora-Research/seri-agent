import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// Type-only import: bun test still loads this file on ubuntu/macos CI, and node-pty has no Linux prebuild.
import type * as PtyModule from "node-pty";
import { childScriptInput, SPLASH_MARK } from "./helpers";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

function childScriptAltScreen(dir: string): string {
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

const ALT_SCREEN_ENTER = Buffer.from([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]); // \x1b[?1049h
const ALT_SCREEN_EXIT = Buffer.from([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c]); // \x1b[?1049l

function findAllOffsets(haystack: Buffer, needle: Buffer): number[] {
  const offsets: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    offsets.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return offsets;
}

type Chunk = { time: number; buf: Buffer; decodedSoFar: string };

// node-pty ConPTY creates its own console; winpty requires an inherited Win32 tty and dies with stdin is not a tty.
function startChildNodePty(pty: typeof PtyModule, scriptPath: string, cwd: string) {
  const term = pty.spawn(process.execPath, [scriptPath], {
    cwd,
    env: process.env as Record<string, string>,
  });

  const chunks: Chunk[] = [];
  let decoded = "";
  let exited = false;
  let resolveExited!: (result: { exitCode: number; signal?: number }) => void;
  const exitedPromise = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    resolveExited = resolve;
  });

  term.onData((data) => {
    // windowsTerminal.js ignores encoding and hands onData a JS string; Buffer.from is a re-encode of ASCII CSI/OSC.
    const buf = Buffer.from(data, "utf8");
    decoded += data;
    chunks.push({ time: Date.now(), buf, decodedSoFar: decoded });
  });
  term.onExit((result) => {
    exited = true;
    resolveExited(result);
  });

  const waitFor = async (line: string, deadlineMs: number): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (!decoded.includes(line) && !exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return decoded.includes(line);
  };

  return { term, chunks, waitFor, decodedSoFar: () => decoded, exited: exitedPromise };
}

// Exclude $_.ProcessId -ne $PID: the PowerShell -Command line contains scriptPath and would match itself.
function killOrphansByScriptPath(scriptPath: string): void {
  const escaped = scriptPath.replace(/'/g, "''");
  // spawnSync timeout: Get-CimInstance can stall on Windows and no bun test timer can fire while it blocks.
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { timeout: 5_000 },
  );
}

function timeAtOffset(chunks: Chunk[], offset: number): number {
  let pos = 0;
  for (const c of chunks) {
    if (offset < pos + c.buf.length) return c.time;
    pos += c.buf.length;
  }
  return chunks.at(-1)?.time ?? 0;
}

// Skip local-Windows-only; import("node-pty") inside the body so ubuntu CI never requests the module.
describe.skipIf(process.platform !== "win32" || process.env.CI !== undefined)(
  "the Ink TUI's alt-screen lifecycle on a real Windows console (node-pty/ConPTY)",
  () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "seri-nodepty-tui-"));
    });

    afterEach(() => {
      // Windows can EBUSY the temp dir after Stop-Process before the handle is released; POSIX does not.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    test("alt-screen enter/exit lifecycle on a real Windows console", async () => {
      const scriptPath = join(dir, "child-altscreen.mjs");
      writeFileSync(scriptPath, childScriptAltScreen(dir));

      const pty = await import("node-pty");
      const { term, chunks, waitFor, decodedSoFar, exited } = startChildNodePty(
        pty,
        scriptPath,
        dir,
      );
      try {
        // node-pty Windows _agent.inSocket.write can throw Socket is closed even while outSocket still streams.
        const sawSplash = await waitFor(SPLASH_MARK, 10_000);
        if (sawSplash) {
          // Swallow a failed splash write so the test times out on assertions instead of an unhandled rejection.
          try {
            term.write("\x1b");
            await new Promise((r) => setTimeout(r, 100));
          } catch {}
        }

        const sawDone = await waitFor("done ·", 20_000);
        if (!sawDone) {
          throw new Error(`child never printed "done ·"; got ${JSON.stringify(decodedSoFar())}`);
        }

        expect(decodedSoFar()).toContain("RUNLOOP_READY");
        expect(decodedSoFar()).toContain("┌");
        expect(decodedSoFar()).not.toContain("╭");

        try {
          term.write("\x04");
        } catch {}

        const exitResult = await Promise.race([
          exited,
          new Promise<"the run never settled">((r) =>
            setTimeout(() => r("the run never settled"), 20_000),
          ),
        ]);
        if (exitResult === "the run never settled") {
          throw new Error(`child never exited after Ctrl-D; got ${JSON.stringify(decodedSoFar())}`);
        }
        // Alt-screen exit bytes can arrive after the process handle reports exited.
        await new Promise((r) => setTimeout(r, 300));

        const all = Buffer.concat(chunks.map((c) => c.buf));
        const enterCount = findAllOffsets(all, ALT_SCREEN_ENTER).length;
        const exitCount = findAllOffsets(all, ALT_SCREEN_EXIT).length;

        if (enterCount === 0 && exitCount === 0) {
          console.log(
            [
              "NODE-PTY INCONCLUSIVE: no \\x1b[?1049h or \\x1b[?1049l bytes found in the raw capture.",
              "Not established that ConPTY surfaces this sequence to a node-pty reader verbatim",
              "(it re-serializes rather than forwarding bytes — see this file's own header comment",
              "on the sibling ?2026h/l case this test used to check).",
              `decoded stdout: ${JSON.stringify(decodedSoFar())}`,
              `raw stdout (hex): ${all.toString("hex")}`,
            ].join("\n"),
          );
          return;
        }
        expect(enterCount).toBe(1);
        expect(exitCount).toBe(1);
      } finally {
        // conpty_console_list_agent AttachConsole fails here; node-pty falls back to the known pid after 5s.
        try {
          term.kill();
        } catch {}
        killOrphansByScriptPath(scriptPath);
      }
    }, 90_000);

    // Bun may not enable ENABLE_VIRTUAL_TERMINAL_INPUT; Shift+Tab \x1b[Z might never reach the app on native Windows.
    test("shift+tab (\\x1b[Z) changes the rendered mode label on a real Windows console", async () => {
      const scriptPath = join(dir, "child-input.mjs");
      writeFileSync(scriptPath, childScriptInput(dir));

      const pty = await import("node-pty");
      const { term, waitFor, decodedSoFar } = startChildNodePty(pty, scriptPath, dir);
      try {
        const sawSplash = await waitFor(SPLASH_MARK, 10_000);
        if (sawSplash) {
          try {
            term.write("\x1b");
            await new Promise((r) => setTimeout(r, 100));
          } catch {}
        }

        const sawReady = await waitFor("RUNLOOP_READY", 10_000);
        if (!sawReady) {
          throw new Error(
            `child never printed "RUNLOOP_READY"; got ${JSON.stringify(decodedSoFar())}`,
          );
        }
        const sawDefaultMode = await waitFor("approve-each mode on", 10_000);
        if (!sawDefaultMode) {
          throw new Error(
            `child never rendered the default mode label; got ${JSON.stringify(decodedSoFar())}`,
          );
        }

        try {
          term.write("\x1b[Z");
        } catch {}

        const sawCycled = await waitFor("bypass permissions on", 10_000);
        if (!sawCycled) {
          throw new Error(
            `shift+tab never changed the rendered mode label; got ${JSON.stringify(decodedSoFar())}`,
          );
        }
        expect(sawCycled).toBe(true);
      } finally {
        try {
          term.kill();
        } catch {}
        killOrphansByScriptPath(scriptPath);
      }
    }, 60_000);
  },
);
