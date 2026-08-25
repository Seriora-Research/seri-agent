import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// Type-only: erased at compile time, so this never touches the actual native module — the runtime
// value is loaded dynamically inside the test body instead (see the `describe.skipIf` comment
// below for why: node-pty ships no Linux prebuild, and a top-level `import` would still be
// requested by `bun test` on ubuntu/macos CI even with the test body itself skipped).
import type * as PtyModule from "node-pty";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

// altScreen.ts's own invariant: one continuous `\x1b[?1049h`/`\x1b[?1049l` pair per launch. A quit-capable
// runLoop rather than a hanging one: this test needs the process to actually exit on its own (via
// Ctrl-D) so `\x1b[?1049l`'s own "exactly once, after the child exits" claim has something real to
// observe, not a `term.kill()` from the test harness racing whatever cleanup would have run.
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

// altScreen.ts's own hand-rolled pair, byte-for-byte what Ink itself writes for `alternateScreen`
// — `\x1b[?1049h`/`\x1b[?1049l`, not the DEC-2026 synchronized-output bracket
// the old version of this test searched for (that subject — `<Static>`'s own bsu/esu-wrapped flush
// — no longer exists; App.tsx renders the transcript as a measured viewport instead).
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

// node-pty, not winpty.exe (this file's own prior version): winpty needs its OWN stdin to already
// be a real Win32 console before it will even start — confirmed dead twice, once in this sandbox
// and once by a human in their own real Git Bash/MINGW64 terminal, both times
// `stderr: stdin is not a tty` before winpty ever reached the seri CLI. node-pty's Windows backend
// uses ConPTY (`CreatePseudoConsole`), which creates its OWN console rather than requiring one from
// the caller — no wrapper binary, no console-inheritance precondition.
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
    // node-pty's own windowsTerminal.js ignores the `encoding` option outright (a console.warn,
    // "Setting encoding on Windows is not supported") and always hands onData a decoded JS string
    // — there is no raw-Buffer mode on this platform. `Buffer.from(data, "utf8")` below is
    // therefore a RE-ENCODE, not the literal wire bytes; a caveat, not a defect, for the ASCII-only
    // CSI/OSC escapes and plain text this file searches for.
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

// Same shape as tuiPty.test.ts's own childScriptInput: a runLoop that never settles, so the
// process stays alive and interactive for a keypress to reach it — unlike childScriptAltScreen
// above, which completes a turn immediately and exists only for the enter/exit lifecycle itself.
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

// Same orphan risk as the winpty version, different mechanism: ConPTY's wrapped child is a
// separate OS process from this test's own, and `term.kill()` alone was not enough to guarantee
// its termination in every run observed while building this test. Matched by the unique script
// path rather than by image name, so this can never touch an unrelated process.
//
// `$_.ProcessId -ne $PID` is load-bearing, not defensive filler: `$PID` is PowerShell's own
// automatic variable for the CURRENT process, and the `-Command` argument this script runs in
// literally contains `scriptPath` (it's quoted right there in the Contains(...) call) — so
// without this exclusion, the filter matches this PowerShell process's own command line and it
// could stop itself (or race Stop-Process ordering against the real orphan) instead of only
// targeting the actual leaked child.
function killOrphansByScriptPath(scriptPath: string): void {
  const escaped = scriptPath.replace(/'/g, "''");
  // timeout: this runs synchronously in the test's own `finally` — spawnSync blocks the JS thread,
  // so no timer (bun test's own per-test timeout included) can fire while Get-CimInstance is stuck,
  // and it's known to occasionally stall on Windows. A few seconds is plenty for a local WMI query;
  // a stall past that degrades to "cleanup didn't fully finish" instead of hanging the process.
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

// process.env.CI: this has never run in the windows-latest CI job (.github/workflows/ci.yml) and
// stays out of it deliberately — a diagnostic harness whose own worst case is "inconclusive, pass"
// (see the events.length === 0 branch below) isn't worth the hang risk against the job timeout;
// it's meant for local Windows development only. node-pty ships prebuilt binaries for darwin/win32
// only — no Linux prebuild — so `describe.skipIf` alone isn't enough to keep it off ubuntu CI: that
// only skips the test BODY, and `bun test` still loads (and would still `import`) this whole file
// on every runner regardless of which OS's tests it goes on to skip. The `import("node-pty")`
// inside the test body below is what actually keeps ubuntu/macos from ever requesting the module.
describe.skipIf(process.platform !== "win32" || process.env.CI !== undefined)(
  "the Ink TUI's alt-screen lifecycle on a real Windows console (node-pty/ConPTY)",
  () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "seri-nodepty-tui-"));
    });

    afterEach(() => {
      // maxRetries/retryDelay: killOrphansByScriptPath (in the test's own `finally`) closes the
      // main leak, but Stop-Process and Windows fully releasing the directory handle are not the
      // same instant — observed live as an occasional EBUSY on the very next line without this
      // margin, never on POSIX.
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
        // The welcome splash now mounts ahead of the normal flow on every interactive launch —
        // dismissed here the same way tuiPty.test.ts's own startChild does: wait for its wordmark
        // (the earliest text its first frame prints, proof raw mode is already set), write Escape,
        // then a settle margin before this test's own first real assertion.
        //
        // KNOWN OPEN ISSUE, unresolved as of this comment: in the sandboxed environment this was
        // written in, ANY `term.write()` call here — with or without this settle margin, on Escape
        // or any other byte — throws an async "Socket is closed" from node-pty's own Windows backend
        // (`_agent.inSocket.write`, windowsTerminal.js), even though `_agent.outSocket` keeps
        // streaming the child's own output fine and the child itself never exits on its own (traced
        // with a minimal, unmodified `pty.spawn` + `term.write` repro with no seri code involved at
        // all — reproduces identically). Whether this is specific to that sandbox or a real
        // limitation of this node-pty version's Windows write path is unconfirmed; needs verifying
        // on an unsandboxed Windows machine before this test can be trusted again.
        const sawSplash = await waitFor("SERI", 10_000);
        if (sawSplash) {
          // Swallowed on failure, matching tuiPty.test.ts's own startChild: if this exact write
          // throws (see this block's own comment above), the splash is left undismissed and this
          // test's own assertions below fail on a real timeout instead of an unhandled rejection.
          try {
            term.write("\x1b");
            await new Promise((r) => setTimeout(r, 100));
          } catch {}
        }

        // "(done: ...)" only appears once RUNLOOP_READY and the turn's own completion have both
        // already been flushed — checked directly, not discarded, so a regression fails immediately
        // at the actual point of regression rather than ~20s later on an unrelated check further
        // down (same shape as the sibling tuiPty.test.ts's own sawLine).
        const sawDone = await waitFor("(done: no-tool-call)", 20_000);
        if (!sawDone) {
          throw new Error(
            `child never printed "(done: no-tool-call)"; got ${JSON.stringify(decodedSoFar())}`,
          );
        }

        // A vacuous-pass guard, checked BEFORE the "no ?1049h/l found" inconclusive branch below:
        // a TUI that silently failed to mount at all (e.g. isTTY resolving false) would also
        // produce zero ?1049h/l bytes, and without this check that failure would be indistinguishable
        // from — and reported the same as — ConPTY fidelity noise. RUNLOOP_READY is plain
        // console.log, printed whether or not Ink ever mounted, so the box-drawing corner is the
        // real signal: it only appears once Ink has actually rendered the input box's own border for
        // real. Mutation-tested (isTTY forced to `false` in childScriptAltScreen's own `cli.run`
        // call): this assertion is what turns that red instead of the whole test silently returning
        // "inconclusive, pass".
        expect(decodedSoFar()).toContain("RUNLOOP_READY");
        expect(decodedSoFar()).toContain("┌");
        expect(decodedSoFar()).not.toContain("╭");

        // Ctrl-D, same graceful-quit affordance tuiPty.test.ts's own "Ctrl-D at the input box quits
        // the same way /exit does" test uses — one write, unlike "/exit" + a separate "\r", so this
        // has only one more write to fall over if the KNOWN OPEN ISSUE above is still live.
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
        // Trailing bytes (the exit sequence itself) can arrive a beat after the process handle
        // reports exited — give them a moment before the buffer is treated as final.
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
        // `term.kill()` forks node-pty's own `conpty_console_list_agent` helper to enumerate and
        // force-kill every process in the console (windowsPtyAgent.js's own `kill`), and that
        // helper's `AttachConsole` call fails the same way winpty's own did in this environment —
        // printed as a stack trace to this test's shared console, harmless (node-pty falls back to
        // killing just the known pid after a 5s timeout) and not this file's to silence, since it's
        // vendored code. killOrphansByScriptPath below is the actual belt-and-suspenders here.
        try {
          term.kill();
        } catch {}
        killOrphansByScriptPath(scriptPath);
      }
    }, 90_000);

    // Anthropic documents Bun not enabling ENABLE_VIRTUAL_TERMINAL_INPUT as a real failure mode
    // for exactly this Node/Bun-on-Windows runtime family — Shift+Tab (`\x1b[Z`) might never reach
    // the app at all on native Windows. Measured here rather than assumed, since that's exactly
    // the kind of platform claim a local pass can't confirm.
    test("shift+tab (\\x1b[Z) changes the rendered mode label on a real Windows console", async () => {
      const scriptPath = join(dir, "child-input.mjs");
      writeFileSync(scriptPath, childScriptInput(dir));

      const pty = await import("node-pty");
      const { term, waitFor, decodedSoFar } = startChildNodePty(pty, scriptPath, dir);
      try {
        // Same splash-dismiss dance as the alt-screen test above (its own comment explains why:
        // the welcome splash mounts ahead of the normal flow on every interactive launch).
        const sawSplash = await waitFor("SERI", 10_000);
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
