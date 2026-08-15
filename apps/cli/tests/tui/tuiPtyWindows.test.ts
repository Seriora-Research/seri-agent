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

// The tui-feedback-delay investigation's own reproduction target: a fake runLoop that emits a
// write_file tool-call followed (after a short delay standing in for real tool execution time) by
// its tool-result, so the reducer (tui/reducer.ts's applyLoopEvent) appends the exact
// "✓ write_file done" confirmation line (cli/output.ts's toolResultLine) to the transcript — the
// same line users reported as delayed on-screen. No approval prompt is involved: these are raw
// LoopEvents fed directly to the reducer, bypassing runLoop's own gate entirely, the same shortcut
// tuiPty.test.ts's own childScript* helpers already take for events that don't need one.
function childScriptToolWrite(dir: string): string {
  return [
    `process.env.GROQ_API_KEY = "fake-test-key";`,
    `const cli = await import(${JSON.stringify(CLI)});`,
    `async function* runLoopFake(opts) {`,
    `  console.log("\\nRUNLOOP_READY");`,
    `  yield { type: "tool-call", name: "write_file", args: { path: "done.md", content: "done" } };`,
    `  await new Promise((resolve) => setTimeout(resolve, 50));`,
    `  yield { type: "tool-result", name: "write_file", result: "ok" };`,
    `  yield { type: "done", reason: "no-tool-call" };`,
    `  return opts.messages;`,
    `}`,
    `await cli.run(["crea", "done.md", "con", "el", "texto", "done"], {`,
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

// The two DEC private-mode-2026 (synchronized output) escape sequences Ink's write-synchronized.js
// wraps every <Static> flush in (ink.js's renderInteractiveFrame) — see this loop's own background
// notes for the exact file:line citations.
const BSU = Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68]); // \x1b[?2026h
const ESU = Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]); // \x1b[?2026l

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
  term.onExit(() => {
    exited = true;
  });

  const waitFor = async (line: string, deadlineMs: number): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (!decoded.includes(line) && !exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return decoded.includes(line);
  };

  return { term, chunks, waitFor, decodedSoFar: () => decoded };
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
  "the Ink TUI's synchronized-output protocol on a real Windows console (node-pty/ConPTY)",
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

    test("bsu/esu pairing and timing around a write_file confirmation line", async () => {
      const scriptPath = join(dir, "child-tool-write.mjs");
      writeFileSync(scriptPath, childScriptToolWrite(dir));

      const pty = await import("node-pty");
      const { term, chunks, waitFor, decodedSoFar } = startChildNodePty(pty, scriptPath, dir);
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
          term.write("\x1b");
          await new Promise((r) => setTimeout(r, 100));
        }

        // A single wait covers the whole turn: "(done: ...)" only appears after RUNLOOP_READY, the
        // tool-call line, and the tool-result confirmation line have all already been flushed.
        // Checked directly, not discarded: a regression here used to fall through to the
        // less-specific RUNLOOP_READY/╭ checks below (which can still pass) before eventually
        // failing ~20s later on an unrelated resultChunkIndex check — this fails immediately, at
        // the actual point of regression, naming what never appeared (same shape as the sibling
        // tuiPty.test.ts's own sawLine).
        const sawDone = await waitFor("(done: no-tool-call)", 20_000);
        if (!sawDone) {
          throw new Error(
            `child never printed "(done: no-tool-call)"; got ${JSON.stringify(decodedSoFar())}`,
          );
        }
        // Trailing bytes (the closing esu, if any) can arrive a beat after the decoded text does —
        // give them a moment before the buffer is treated as final.
        await new Promise((r) => setTimeout(r, 300));

        // A vacuous-pass guard, checked BEFORE the "no bsu/esu found" inconclusive branch below:
        // a TUI that silently failed to mount at all (e.g. isTTY resolving false) would also
        // produce zero bsu/esu bytes, and without this check that failure would be indistinguishable
        // from — and reported the same as — winpty/ConPTY fidelity noise. RUNLOOP_READY is plain
        // console.log, printed whether or not Ink ever mounted, so the box-drawing corner is the
        // real signal: it only appears once Ink has actually rendered the ApprovalBox/input-box
        // border for real. Mutation-tested (isTTY forced to `false` in childScriptToolWrite's own
        // `cli.run` call): this assertion is what turns that red instead of the whole test silently
        // returning "inconclusive, pass".
        expect(decodedSoFar()).toContain("RUNLOOP_READY");
        expect(decodedSoFar()).toContain("╭");

        const all = Buffer.concat(chunks.map((c) => c.buf));
        const events = [
          ...findAllOffsets(all, BSU).map((offset) => ({ offset, type: "bsu" as const })),
          ...findAllOffsets(all, ESU).map((offset) => ({ offset, type: "esu" as const })),
        ].sort((a, b) => a.offset - b.offset);

        if (events.length === 0) {
          console.log(
            [
              "NODE-PTY INCONCLUSIVE: no bsu/esu bytes found in the raw capture.",
              `decoded stdout: ${JSON.stringify(decodedSoFar())}`,
              `raw stdout (hex): ${all.toString("hex")}`,
            ].join("\n"),
          );
          return;
        }

        // Where the confirmation flush lives, needed by both (b) and (c) below.
        const resultChunkIndex = chunks.findIndex((c) =>
          c.decodedSoFar.includes("✓ write_file done"),
        );
        expect(resultChunkIndex).toBeGreaterThanOrEqual(0);
        const resultVisibleTime = chunks[resultChunkIndex].time;
        // Bytes preceding and including the chunk the confirmation text first appears in.
        const resultByteOffset = chunks
          .slice(0, resultChunkIndex + 1)
          .reduce((sum, c) => sum + c.buf.length, 0);

        // (b) bsu/esu alternate strictly, starting with bsu, never orphaned and never doubled, and
        // nothing left open, THROUGH the confirmation flush — not the entire remaining capture:
        // the 300ms tail above is enough for the confirmation flush's own esu to land, but a later,
        // slower frame's bsu (a subsequent Static flush this test doesn't otherwise wait for) could
        // still be mid-flight with its esu not yet arrived when the snapshot above was taken, and
        // that has nothing to do with the claim this test is actually making. This is a sanity check
        // on ConPTY's OWN re-serialized output stream, not on what Ink literally wrote to its pty: a
        // real capture of this exact scenario decoded to
        // `...\x1b[?2026h\x1b[m\x1b[?2026l\x1b[5;1H✓ write_file done...` — bsu, an SGR reset, esu,
        // THEN the cursor move and the text, with nothing resembling "✓ write_file done" between bsu
        // and esu at all (three of the four pairs captured were fully empty; the fourth — this one
        // — held only the 3-byte SGR reset). Ink's own literal write is `bsu → staticOutput → esu`
        // as one call (ink.js:779-790) with the rendered frame INSIDE the bracket; what this harness
        // observes instead is ConPTY's own synthesized bracket around its own screen-buffer diff,
        // since ConPTY applies the child's VT stream to an internal buffer and re-serializes its own
        // output for the reader rather than forwarding bytes verbatim. This pairing check therefore
        // says nothing about whether INK's own bracket was well-formed — that's established by
        // reading ink.js:779-790, not by this capture — it only confirms ConPTY's re-serialization
        // is itself internally consistent.
        const relevantEvents = events.filter((e) => e.offset < resultByteOffset);
        let open = false;
        for (const e of relevantEvents) {
          if (e.type === "bsu") {
            expect(open).toBe(false);
            open = true;
          } else {
            expect(open).toBe(true);
            open = false;
          }
        }
        expect(open).toBe(false);

        // (c) bounded latency between the write_file confirmation flush's esu and the confirmation
        // text becoming visible. Not evidence either way about Ink/seri: since the bracket is
        // ConPTY's own synthesized one (see (b)'s comment) and Windows' console host does not
        // implement DEC 2026 (the pair has zero visible effect there), this observation falsifies
        // "the sync bracket is holding a stale frame open" on THIS path rather than confirming
        // anything about who would be at fault if it were true — nothing is actually being
        // synchronized here. What's left worth asserting: the bracket and the content near it still
        // land close together in wall-clock time; a real stall in seri's own event pipeline (as
        // opposed to ConPTY's harmless re-ordering) would show up as a large gap here instead.
        // The esu nearest resultByteOffset, not simply the last esu in the whole capture (a later,
        // unrelated Static flush — e.g. a subsequent turn — would otherwise be picked instead).
        const nearestEsuOffset = findAllOffsets(all, ESU)
          .filter((offset) => offset < resultByteOffset)
          .at(-1);
        expect(nearestEsuOffset).toBeDefined();
        const nearestEsuTime = timeAtOffset(chunks, nearestEsuOffset as number);
        expect(Math.abs(resultVisibleTime - nearestEsuTime)).toBeLessThan(500);
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
    }, 60_000);
  },
);
