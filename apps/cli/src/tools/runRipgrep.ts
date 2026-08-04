import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onSignalCleanup } from "../signals";
import rgAsset from "./rg-vendored.bin" with { type: "file" };

// @vscode/ripgrep's own `rgPath` export resolves the platform binary via a dynamic,
// template-built `require.resolve(...)` call. That's fine for `bun run`/`bun test` (real
// node_modules on disk), but inside a `bun build --compile` standalone executable it
// resolves against the CURRENT WORKING DIRECTORY at runtime, not anything embedded in the
// binary — so it throws "Could not find @vscode/ripgrep-<platform>" the instant seri is
// run from any directory other than this repo's own checkout. `rg-vendored.bin` (see
// vendorRipgrep.ts, run via `postinstall`) is a literal local file, so bun embeds its bytes
// directly into the compiled executable, CWD-independent. The embedded asset resolves to
// bun's virtual `B:/~BUN/root/...` path, which isn't a real file `spawnSync` can execute —
// extract it to a real temp file once at startup.
//
// The pid goes in the name so a later run can tell an abandoned directory from a live one; see
// sweepAbandonedRgDirs. The prefix is what identifies these as ours.
const RG_DIR_PREFIX = "seri-rg-";

// Every prefix this project has ever created directories under. New ones always use
// RG_DIR_PREFIX; the older names are here because the sweep is the only thing that ever deletes
// them, so dropping one from this list does not merely stop cleaning those directories — it
// orphans them permanently, since nothing else on the machine knows the name. `hesper-rg-` is
// what the binary was called before it was renamed to `seri`.
const SWEEP_PREFIXES = [RG_DIR_PREFIX, "hesper-rg-"] as const;
const bytes = new Uint8Array(await Bun.file(rgAsset).arrayBuffer());
const rgDir = mkdtempSync(join(tmpdir(), `${RG_DIR_PREFIX}${process.pid}-`));
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

// 'exit' does not fire when a signal ends the process — verified: a SIGTERM left the dir behind.
onSignalCleanup(cleanUpExtractedRg);

// Whether the owner of a directory is still using it. Any error other than ESRCH counts as
// alive: signal 0 sends nothing and only asks, but it can still fail for reasons that are not
// "gone" (EPERM, a pid owned by another user). Guessing "alive" costs one leaked directory that
// the next run reconsiders; guessing "dead" breaks a session that is still running.
// `prefix` is whichever SWEEP_PREFIXES entry matched, not RG_DIR_PREFIX: they differ in length,
// so slicing by the wrong one shifts the pid segment and the name parses as a legacy one.
function isOwnerAlive(name: string, prefix: string): boolean {
  // Legacy names are the prefix plus mkdtemp's six random characters and carry no pid segment at
  // all — every directory on disk before this shipped. Nobody owns them, so nothing to protect.
  const segments = name.slice(prefix.length).split("-");
  if (segments.length < 2) return false;

  try {
    process.kill(Number(segments[0]), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// Neither handler above runs when a process is terminated abruptly: on Windows every kill path
// ends in TerminateProcess, which executes no user code whatsoever. So they cannot be the whole
// answer, and a third handler would not be either — the problem is precisely that handlers do
// not run. Each run cleans up after the ones that never got the chance instead. Measured on the
// dev box 2026-08-04: 236 abandoned directories holding 1222 MB, 69 of them created in the last
// 24 hours, the newest postdating the handlers above — an ongoing leak, not a historical one.
// The first run after this ships therefore deletes ~1.2 GB synchronously at startup; that is
// paid once, and steady state is a handful of directories. That measurement predates the rename,
// so most of the backlog it counts sits under the old prefix — which is exactly why the sweep
// walks SWEEP_PREFIXES rather than just the one new runs create.
//
// A live sibling is skipped rather than deleted because it belongs to a concurrent seri, and
// POSIX will happily unlink a running binary: that process keeps working, but the path it
// re-spawns rg from is gone and its next grep fails. Windows refuses to delete a locked rg.exe
// with EPERM, which catches the same case by accident, but only there — the pid check is the
// real protection.
function sweepAbandonedRgDirs(): void {
  for (const name of readdirSync(tmpdir())) {
    const prefix = SWEEP_PREFIXES.find((candidate) => name.startsWith(candidate));
    if (!prefix) continue;

    const dir = join(tmpdir(), name);
    if (dir === rgDir || isOwnerAlive(name, prefix)) continue;

    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A lock or a permission this process does not have. One directory must not abort the
      // sweep, and the next run reaches it anyway.
    }
  }
}

sweepAbandonedRgDirs();

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
  // what seri finds on their machine and nowhere else.
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
