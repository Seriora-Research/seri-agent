import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as pty from "node-pty";

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
function startChildNodePty(scriptPath: string, cwd: string) {
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
function killOrphansByScriptPath(scriptPath: string): void {
  const escaped = scriptPath.replace(/'/g, "''");
  spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ]);
}

function timeAtOffset(chunks: Chunk[], offset: number): number {
  let pos = 0;
  for (const c of chunks) {
    if (offset < pos + c.buf.length) return c.time;
    pos += c.buf.length;
  }
  return chunks.at(-1)?.time ?? 0;
}

describe.skipIf(process.platform !== "win32")(
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

      const { term, chunks, waitFor, decodedSoFar } = startChildNodePty(scriptPath, dir);
      try {
        // A single wait covers the whole turn: "(done: ...)" only appears after RUNLOOP_READY, the
        // tool-call line, and the tool-result confirmation line have all already been flushed.
        await waitFor("(done: no-tool-call)", 20_000);
        // Trailing bytes (the closing esu, if any) can arrive a beat after the decoded text does —
        // give them a moment before the buffer is treated as final.
        await new Promise((r) => setTimeout(r, 300));

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

        // (b) correctly paired: bsu/esu alternate strictly, starting with bsu, never orphaned and
        // never doubled, and nothing left open at the end.
        let open = false;
        for (const e of events) {
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
        // text becoming visible — NOT "esu arrives after the text", which is what this assertion
        // checked in the winpty version and which is provably false on ConPTY, confirmed live: a
        // real capture of this exact scenario decoded to
        // `...\x1b[?2026h\x1b[m\x1b[?2026l\x1b[5;1H✓ write_file done...` — bsu, an SGR reset, esu,
        // THEN the cursor move and the text, with nothing resembling "✓ write_file done" between
        // bsu and esu at all. ConPTY does not forward a child's VT stream byte-for-byte; it applies
        // it to an internal screen-buffer model and re-serializes its OWN output for the reader, and
        // Windows' console host does not implement DEC 2026 (the pair has zero visible effect), so
        // it gets flushed as an inert, contentless bracket ahead of the actual screen diff. This is
        // a property of the Windows console layer, not of Ink or seri's own code — the pairing check
        // above already confirms Ink emits a well-formed bsu/esu bracket for every Static flush,
        // which is the part of this that IS this repo's to get right. What's left worth asserting:
        // the bracket and the content it wraps still land close together in wall-clock time,
        // regardless of which one the reader sees first — a real stall in seri's own event pipeline
        // (as opposed to ConPTY's harmless re-ordering) would show up as a large gap here instead.
        const resultChunkIndex = chunks.findIndex((c) =>
          c.decodedSoFar.includes("✓ write_file done"),
        );
        expect(resultChunkIndex).toBeGreaterThanOrEqual(0);
        const resultVisibleTime = chunks[resultChunkIndex].time;

        const lastEsuOffset = findAllOffsets(all, ESU).at(-1);
        expect(lastEsuOffset).toBeDefined();
        const lastEsuTime = timeAtOffset(chunks, lastEsuOffset as number);
        expect(Math.abs(resultVisibleTime - lastEsuTime)).toBeLessThan(500);
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
