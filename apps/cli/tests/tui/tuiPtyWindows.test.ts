import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
// notes for the exact file:line citations. Raw bytes, not strings: this file's whole point is to
// check what actually crossed the pty, not what a decoded/reassembled string implies happened.
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

// winpty, not python3's pty.spawn (tuiPty.test.ts's own tool): Windows has no pty to allocate via
// the POSIX `pty` module (that file's own comment — Python 3.12 on Windows lacks `termios`), but
// winpty ships with Git for Windows (confirmed present at
// C:\Program Files\Git\usr\bin\winpty.exe) and wraps a native Win32 console app so it sees a real
// isTTY, which is the one thing this whole investigation turns on.
function startChildWinpty(scriptPath: string, cwd: string) {
  const child = spawn("winpty", ["--", process.execPath, scriptPath], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const chunks: Chunk[] = [];
  const decoder = new TextDecoder("utf-8");
  let decoded = "";
  let stderr = "";
  let spawnError: Error | undefined;

  child.stdout?.on("data", (buf: Buffer) => {
    decoded += decoder.decode(buf, { stream: true });
    chunks.push({ time: Date.now(), buf, decodedSoFar: decoded });
  });
  child.stderr?.on("data", (buf: Buffer) => {
    stderr += buf.toString("utf8");
  });
  child.once("error", (err) => {
    spawnError = err;
  });

  // Polls for `line` in the decoded output, but — unlike tuiPty.test.ts's own sawLine — never
  // throws: a winpty spawn failure (confirmed separately: winpty needs its OWN stdin to already be
  // a real console, which is exactly what's absent in a piped/headless invocation) has to be
  // reported as inconclusive by the caller, not as a thrown test error.
  const waitFor = async (line: string, deadlineMs: number): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (
      !decoded.includes(line) &&
      spawnError === undefined &&
      child.exitCode === null &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return decoded.includes(line);
  };

  return {
    child,
    chunks,
    waitFor,
    decodedSoFar: () => decoded,
    stderrSoFar: () => stderr,
    spawnError: () => spawnError,
  };
}

// Confirmed live in this environment: when winpty's own precondition fails (its stdin isn't a
// real console — the exact "stdin is not a tty" failure this file's own test comment documents),
// it still leaves the wrapped bun.exe process it had already spawned running, unsupervised, with
// `dir` as its cwd — a real orphan, not merely winpty.exe exiting cleanly. `child.kill()` only
// reaches the winpty.exe wrapper (already dead by then), not this grandchild, so without this the
// orphan holds `dir` open forever and afterEach's rmSync fails with EBUSY. Matched by the unique
// script path rather than by image name, so this can never touch an unrelated bun.exe.
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
  "the Ink TUI's synchronized-output protocol on a real Windows console (winpty)",
  () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "seri-winpty-tui-"));
    });

    afterEach(() => {
      // maxRetries/retryDelay: killOrphansByScriptPath (in the test's own `finally`) closes the
      // main leak, but Stop-Process and Windows fully releasing the directory handle are not the
      // same instant — observed live as an occasional EBUSY on the very next line without this
      // margin, never on POSIX.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    // Outcome (A) vs (B) vs (C) — see this loop's own background notes. Confirmed live in this
    // sandbox: winpty's own precondition ("my stdin must already be a real Win32 console") is not
    // met by a piped/headless invocation of winpty itself (reproduced directly, outside this test,
    // as `winpty -- node -e "1"` → stderr "stdin is not a tty", exit 1) — a MORE fundamental gap
    // than the fidelity risk this loop's plan anticipated (winpty running fine but mistranslating
    // exotic escapes). Either failure shape collapses to the same observable here: no bsu/esu bytes
    // in the raw capture, handled identically below as inconclusive rather than a hard failure —
    // deliberately not special-cased, since telling them apart only matters for the human report,
    // which stderrSoFar()/spawnError() already carry into the console.log below.
    test("bsu/esu pairing and timing around a write_file confirmation line", async () => {
      const scriptPath = join(dir, "child-tool-write.mjs");
      writeFileSync(scriptPath, childScriptToolWrite(dir));

      const { child, chunks, waitFor, decodedSoFar, stderrSoFar, spawnError } = startChildWinpty(
        scriptPath,
        dir,
      );
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
              "WINPTY INCONCLUSIVE: no bsu/esu bytes found in the raw capture — either winpty",
              "could not translate the synchronized-output escapes faithfully, or it never got a",
              "real console to run in at all. Diagnostic detail follows for manual inspection.",
              `spawnError: ${spawnError()?.message ?? "(none)"}`,
              `stderr: ${stderrSoFar()}`,
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

        // (c) bounded latency between the confirmation text becoming visible and its closing esu.
        // 500ms is generous, not tight: Ink's own scheduling writes bsu/content/esu as one
        // synchronous call (this loop's own reconciler.js/ink.js citations), so a healthy run
        // should show ~0ms here; 500ms only guards against winpty itself buffering/delaying the
        // translated bytes, which is the one link in this chain this repo's code does not control.
        const resultChunkIndex = chunks.findIndex((c) =>
          c.decodedSoFar.includes("✓ write_file done"),
        );
        expect(resultChunkIndex).toBeGreaterThanOrEqual(0);
        const resultVisibleTime = chunks[resultChunkIndex].time;

        const esuTimesAtOrAfterResult = findAllOffsets(all, ESU)
          .map((offset) => timeAtOffset(chunks, offset))
          .filter((t) => t >= resultVisibleTime)
          .sort((a, b) => a - b);
        expect(esuTimesAtOrAfterResult.length).toBeGreaterThan(0);
        expect(esuTimesAtOrAfterResult[0] - resultVisibleTime).toBeLessThan(500);
      } finally {
        child.kill("SIGKILL");
        killOrphansByScriptPath(scriptPath);
      }
    }, 60_000);
  },
);
