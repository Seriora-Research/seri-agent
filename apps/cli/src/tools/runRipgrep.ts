import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../../package.json";
import { getConfigDir } from "../config/paths";
import rgAsset from "./rg-vendored.bin" with { type: "file" };

// A wedged rg is killed rather than left hanging the session. 30 s, not the 10 s Claude Code
// passes: the --sort note further down records a legitimate 9 s search of a large tree, which
// 10 s would leave about a second of margin over.
const RG_TIMEOUT_MS = 30_000;

let resolution: string | undefined;

// Resolved once, on the first actual search: --version, login, logout and config never search, so
// they never write, stat or spawn anything. It never re-resolves, so an rg that goes missing
// mid-session fails loudly rather than being silently replaced under the caller.
export function resolveRg(): string {
  resolution ??= detectRg();
  return resolution;
}

function detectRg(): string {
  try {
    const cached = rgCachePath();
    if (!isCachedRg(cached)) populateCache(cached);
    return cached;
  } catch {
    // getConfigDir() throws outright when LOCALAPPDATA is unset, and the directory it names can be
    // read-only or full. Not noexec: that fails at exec time, which happens outside this try, so
    // the fallback never sees it — and tmpdir() is itself sometimes mounted noexec, so falling
    // back would not help if it did. Falling back to a temp copy keeps the invariant that matters:
    // seri always searches with the rg it vendored, on every machine. Borrowing an rg off PATH
    // would need a version floor and a capability probe to defend, and would still leave the user
    // with different ignore, hidden-file and binary-detection defaults than this suite ever runs.
    return extractToTemp();
  }
}

// @vscode/ripgrep's own `rgPath` export resolves the platform binary via a dynamic,
// template-built `require.resolve(...)` call. That's fine for `bun run`/`bun test` (real
// node_modules on disk), but inside a `bun build --compile` standalone executable it
// resolves against the CURRENT WORKING DIRECTORY at runtime, not anything embedded in the
// binary — so it throws "Could not find @vscode/ripgrep-<platform>" the instant seri is
// run from any directory other than this repo's own checkout. `rg-vendored.bin` (see
// vendorRipgrep.ts, run via `postinstall`) is a literal local file, so bun embeds its bytes
// directly into the compiled executable, CWD-independent. The embedded asset resolves to
// bun's virtual `B:/~BUN/root/...` path, which isn't a real file `spawnSync` can execute, so
// it has to reach disk — but once per seri version, not once per run.
//
// Keyed so a cached binary can never outlive the asset it came from: seri ships exactly one
// vendored rg per release, so a version bump always changes the key, and the asset's size catches
// a developer re-vendoring a different rg without bumping. Hashing the asset instead was measured
// and rejected — SHA-256 over 5.4 MB costs the same order as the 2.80 ms write it would be
// protecting, so it would defeat the cache on every hit; statSync costs 0.033 ms and returns the
// real 5 429 760 even for the compiled build's virtual asset path.
function rgCachePath(): string {
  const key = `${pkg.version}-${process.platform}-${process.arch}-${statSync(rgAsset).size}`;
  return join(getConfigDir(), "rg", key, process.platform === "win32" ? "rg.exe" : "rg");
}

// Verified, not trusted: two stats cost 0.033 ms against running a 5 MB binary that a full disk or
// a botched restore left short. The exec bit counts as much as the size — a home restored from a
// backup, an rsync without -p or a round trip through exFAT strips it, and an entry that is the
// right size but not executable would fail EACCES on every run from then on, since resolution
// never re-resolves and nothing would ever repair it. Treating it as a miss costs one rewrite.
function isCachedRg(cached: string): boolean {
  if (!existsSync(cached)) return false;

  const stats = statSync(cached);
  return stats.size === statSync(rgAsset).size && (process.platform === "win32" || (stats.mode & 0o111) !== 0);
}

// Published by renaming a fully written, already chmodded file — never by writing in place, and
// never by renaming a directory. Measured on Windows: file → existing file succeeds even when the
// target is executing right now, while directory → existing directory fails with EPERM, so the
// "build it in a temp dir and swap the dir in" shape would break on Windows alone. A run killed
// mid-write therefore leaves a stray .tmp, never a truncated rg.
//
// No lock, because every racer writes byte-identical bytes under the same key to its own
// pid-suffixed name — but "identical content makes the race benign" is only true once the losing
// rename is handled. Two simultaneous MoveFileEx replace-existing calls to one target do collide
// on Windows: measured 2 EPERM failures across 8 runs of 4 concurrent processes, which without the
// catch below is a hard failure of somebody's search. The loser has nothing to do but drop its
// copy and use what the winner published, and it re-checks the size before believing that.
function populateCache(cached: string): void {
  mkdirSync(dirname(cached), { recursive: true });
  const tmp = `${cached}.${process.pid}.tmp`;
  writeFileSync(tmp, readFileSync(rgAsset));
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  // Twice, not once. A loser almost always finds the winner's file already in place and adopts
  // it — measured 28 collisions across 12 rounds of 6 racers, 28 adoptions — but an EPERM can
  // also be observed in the window *before* the winner's rename publishes, and the check would
  // then have nothing to find. Without the second attempt that racer abandons the cache and runs
  // the rest of its session from the temp fallback.
  for (const attempt of [1, 2]) {
    try {
      renameSync(tmp, cached);
      return;
    } catch (error) {
      if (isCachedRg(cached)) break;
      if (attempt === 2) {
        rmSync(tmp, { force: true });
        throw error;
      }
    }
  }
  rmSync(tmp, { force: true });
}

function extractToTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-rg-"));
  const path = join(dir, process.platform === "win32" ? "rg.exe" : "rg");
  writeFileSync(path, readFileSync(rgAsset));
  if (process.platform !== "win32") chmodSync(path, 0o755);

  // Nothing else will ever reclaim this: the sweep that used to hunt abandoned copies is gone
  // along with the per-run extraction that needed it. One 'exit' listener is the entire cleanup —
  // no pid-in-dirname scheme, no readdir of tmpdir at every startup. It does miss signals and
  // Windows' TerminateProcess, so a machine that keeps landing here can still accumulate copies;
  // that residue is bounded by how often a config dir is unwritable, where the leak this replaced
  // was one directory per run of every process on every machine. Closing the remaining gap would
  // mean restoring the apparatus this change exists to delete, which is not worth it for a path
  // reached only on an already-degraded machine.
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Throwing from an exit listener lands after the run's real output and turns a success into
      // an apparent crash — measured at exit code 1 with a stack trace. Windows raises EPERM here
      // while an AV scanner still holds the rg we just executed. One directory left behind is the
      // cheaper failure.
    }
  });
  return path;
}

// The first line of `rg --version` is `ripgrep 15.0.0 (rev 3a612f88b8)`. Only --selftest needs it,
// so no ordinary search ever pays for the spawn.
export function rgVersion(command: string): string {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: RG_TIMEOUT_MS, windowsHide: true });
  if (result.error) throw new Error(`failed to run ${command}: ${result.error.message}`);

  const match = /^ripgrep (\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
  if (!match) throw new Error(`${command} is not ripgrep: --version printed ${JSON.stringify(result.stdout.split("\n")[0]?.trim())}`);
  return `${match[1]}.${match[2]}.${match[3]}`;
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
  // what seri finds on their machine and nowhere else.
  const result = spawnSync(resolveRg(), ["--no-config", ...args], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: RG_TIMEOUT_MS,
    windowsHide: true,
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOBUFS") {
      return { stdout: result.stdout, truncated: true };
    }
    // A timed-out rg arrives as an error rather than an exit code — measured: `status: null`,
    // `signal: "SIGTERM"`, `code: "ETIMEDOUT"`. Without this it would fall into the generic
    // message below, which names spawnSync's wording and never the timeout that caused it.
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error(`rg did not finish within ${RG_TIMEOUT_MS / 1000}s and was killed`);
    }
    // rg never started, so status and stderr are both empty and the exit-code message below
    // would name neither a cause nor a real code — the same unreadable failure this file was
    // fixed for. Reachable when the resolved binary is removed or quarantined mid-session.
    throw new Error(`failed to run rg: ${result.error.message}`);
  }

  // rg exits 1 when there are no matches (not an error); anything else is a real failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`rg exited with code ${result.status}: ${result.stderr}`);
  }

  return { stdout: result.stdout, truncated: false };
}
