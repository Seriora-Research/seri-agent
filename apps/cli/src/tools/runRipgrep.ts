import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rgAsset from "./rg-vendored.bin" with { type: "file" };

// @vscode/ripgrep's own `rgPath` export resolves the platform binary via a dynamic,
// template-built `require.resolve(...)` call. That's fine for `bun run`/`bun test` (real
// node_modules on disk), but inside a `bun build --compile` standalone executable it
// resolves against the CURRENT WORKING DIRECTORY at runtime, not anything embedded in the
// binary — so it throws "Could not find @vscode/ripgrep-<platform>" the instant hesper is
// run from any directory other than this repo's own checkout. `rg-vendored.bin` (see
// vendorRipgrep.ts, run via `postinstall`) is a literal local file, so bun embeds its bytes
// directly into the compiled executable, CWD-independent. The embedded asset resolves to
// bun's virtual `B:/~BUN/root/...` path, which isn't a real file `spawnSync` can execute —
// extract it to a real temp file once at startup.
const bytes = new Uint8Array(await Bun.file(rgAsset).arrayBuffer());
const rgDir = mkdtempSync(join(tmpdir(), "hesper-rg-"));
export const rgPath = join(rgDir, process.platform === "win32" ? "rg.exe" : "rg");
writeFileSync(rgPath, bytes);
if (process.platform !== "win32") chmodSync(rgPath, 0o755);

// Nothing removed this, so every run left another 5 MB copy of rg behind: 207 directories and
// 1.07 GB had accumulated on the machine this was found on.
function cleanUpExtractedRg(): void {
  try {
    // `force` suppresses ENOENT but not EPERM/EBUSY, which Windows raises while an AV scanner
    // or the search indexer still holds the binary we just executed. Retry briefly, then give
    // up: throwing from an exit listener lands after the run's real output and turns a success
    // into an apparent crash — measured at exit code 1 with a stack trace on stderr.
    rmSync(rgDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Leaving one directory behind beats ending a good run with a stack trace.
  }
}

process.on("exit", cleanUpExtractedRg);

// 'exit' does not fire when a signal terminates the process, so on its own the handler above
// missed the most common way an agent run ends: Ctrl-C part way through a turn. Verified — a
// SIGTERM left the directory behind exactly as before the fix.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanUpExtractedRg();

    // Re-raise instead of exiting with 128 + n. A normal exit reports a status, not a death by
    // signal, and shells branch on that: `for f in a b c; do hesper "$f"; done` only breaks out
    // of the loop when the child was killed *by* SIGINT, so a plain exit would turn one Ctrl-C
    // into one press per iteration. xargs and make read it the same way.
    //
    // Node only restores a signal's default disposition when no listener is left, so clearing
    // them is what makes the re-raise land rather than re-entering this handler. That also
    // means a listener registered later — a future "Ctrl-C cancels the turn" — would be
    // dropped here, which is the argument for owning this in cli.ts rather than in a tool.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

// spawnSync buffers rg's entire stdout in memory and kills rg the moment the buffer fills.
// Node's 1 MB default was low enough that an ordinary --json search (one event per match, a
// few hundred bytes each) blew it after a few thousand matches, and the overflow arrives as
// `status: null` with an empty stderr — indistinguishable from an rg crash unless the
// ENOBUFS error is checked. Callers cap their results far below this, so a full buffer only
// ever means "more than we were going to return anyway": that is truncation, not a failure.
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

// How many results grep and glob hand back. A model searching a real repo gains nothing from
// thousands of hits — they bury the useful ones and burn context — so both tools return a
// bounded page and report when there is more. Lives here because the buffer above only has
// to be large enough to reach this cap; the two numbers move together.
//
// Capping makes rg's output order load-bearing, and rg only guarantees an order under
// --sort, which is deliberately not passed: on a large tree --sort=path measured ~7x slower
// (9s -> 69s) because it costs rg its parallelism. So a truncated page is not a stable
// subset across identical runs, and the tool descriptions tell the model exactly that.
export const MAX_RESULTS = 100;

// File lists get a higher cap than matches because they cost far less: a path is tens of
// bytes where a match carries its whole line. 250 is what Claude Code's file search uses.
export const MAX_FILE_RESULTS = 250;

// rg's line-oriented output, with the partial trailing line dropped when a full buffer cut
// the stream mid-line. Shared so every caller drops it the same way.
export function outputLines(stdout: string, truncated: boolean): string[] {
  const lines = stdout.split("\n").filter(Boolean);
  if (truncated) lines.pop();
  return lines;
}

export function runRipgrep(args: string[]): { stdout: string; truncated: boolean } {
  // --no-config: rg reads RIPGREP_CONFIG_PATH from the environment, so without this a
  // developer's own ~/.ripgreprc (--smart-case, --hidden, glob excludes) silently changes
  // what hesper finds on their machine and nowhere else.
  const result = spawnSync(rgPath, ["--no-config", ...args], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOBUFS") {
      return { stdout: result.stdout, truncated: true };
    }
    // rg never started, so status and stderr are both empty and the exit-code message below
    // would name neither a cause nor a real code — the same unreadable failure this file was
    // fixed for. Reachable when the extracted binary is reaped from temp by a tmp cleaner or
    // quarantined by AV mid-session.
    throw new Error(`failed to run rg: ${result.error.message}`);
  }

  // rg exits 1 when there are no matches (not an error); anything else is a real failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`rg exited with code ${result.status}: ${result.stderr}`);
  }

  return { stdout: result.stdout, truncated: false };
}
