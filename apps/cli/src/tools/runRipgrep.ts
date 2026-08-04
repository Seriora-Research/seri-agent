import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../../package.json";
import { getConfigDir } from "../config/paths";
import rgAsset from "./rg-vendored.bin" with { type: "file" };

// @vscode/ripgrep's own `rgPath` export resolves the platform binary via a dynamic,
// template-built `require.resolve(...)` call. That's fine for `bun run`/`bun test` (real
// node_modules on disk), but inside a `bun build --compile` standalone executable it
// resolves against the CURRENT WORKING DIRECTORY at runtime, not anything embedded in the
// binary — so it throws "Could not find @vscode/ripgrep-<platform>" the instant seri is
// run from any directory other than this repo's own checkout. `rg-vendored.bin` (see
// vendorRipgrep.ts, run via `postinstall`) is a literal local file, so bun embeds its bytes
// directly into the compiled executable, CWD-independent. The embedded asset resolves to
// bun's virtual `B:/~BUN/root/...` path, which isn't a real file `spawnSync` can execute, so
// it still has to reach a real one — but once per seri version, into the cache below, rather
// than once per run into a temp directory that nothing reliably deleted.
//
// A wedged rg is killed rather than left hanging the session. 30 s, not the 10 s Claude Code
// passes: the --sort note further down records a legitimate 9 s search of a large tree, which
// 10 s would leave about a second of margin over.
const RG_TIMEOUT_MS = 30_000;

// The oldest ripgrep whose --json output was actually compared against the vendored 15.0.0 and
// found byte-identical (14.1.1, and a 15.1.0 third-party fork agreed too). Not a claim that 13.x
// is broken — a claim that nobody has checked it. Only the major is compared, because the floor's
// minor is 0 and a minor check could therefore never reject anything.
const MIN_RG_MAJOR = 14;

export type RgResolution = { mode: "cached" | "system"; command: string };

let resolution: RgResolution | undefined;

// Resolved once, on the first actual search: --version, login, logout and config never search, so
// they never write, stat or spawn anything. It never re-resolves once cached, deliberately — a
// resolver that noticed its binary had gone and quietly replaced it would turn "an installer or a
// disk cleaner removed rg mid-session" from the named error below into silence, and would make the
// test that parks the binary on disk pass while testing nothing.
export function resolveRg(): RgResolution {
  resolution ??= resolveRgUncached();
  return resolution;
}

function resolveRgUncached(): RgResolution {
  // An explicit path wins over everything, and SERI_USE_BUILTIN_RIPGREP=0 means "whatever is on
  // PATH". Both are the same request — use an rg seri did not vendor — so both take the same gate.
  const forced = process.env.SERI_RIPGREP || (process.env.SERI_USE_BUILTIN_RIPGREP === "0" ? "rg" : undefined);
  if (forced) {
    gateForeignRg(forced);
    return { mode: "system", command: forced };
  }

  try {
    const cached = cachedRgPath();
    if (!isCachedRg(cached)) populateCache(cached);
    return { mode: "cached", command: cached };
  } catch (cacheError) {
    // A read-only home, a noexec mount, LOCALAPPDATA unset, an AV quarantine: the cache is the
    // whole design, so when it cannot be written the only thing left is somebody else's rg. Said
    // out loud rather than silently, because this is the one path where seri searches with a
    // binary it did not ship — once per process, since resolution is memoized.
    try {
      gateForeignRg("rg");
    } catch (systemError) {
      throw new Error(
        `no usable ripgrep: caching the bundled copy failed (${asMessage(cacheError)}) and rg on PATH was rejected (${asMessage(systemError)}). Set SERI_RIPGREP to a ripgrep ${MIN_RG_MAJOR}+ binary, or SERI_USE_BUILTIN_RIPGREP=0 to force the one on PATH.`,
      );
    }
    console.error(`seri: could not cache the bundled ripgrep (${asMessage(cacheError)}); falling back to rg on PATH`);
    return { mode: "system", command: "rg" };
  }
}

// Two spawns an rg seri did not vendor has to survive before it is trusted with a search, and
// neither is on the default path. The version floor rejects what has never been checked; the probe
// then reads back the exact contract grep.ts parses, including the base64 `bytes` fallback that a
// non-UTF-8 line takes — fed on stdin, so it needs no fixture file and leaves nothing behind.
function gateForeignRg(command: string): void {
  const version = rgVersion(command);
  if (Number(version.split(".")[0]) < MIN_RG_MAJOR) {
    throw new Error(`${command} is ripgrep ${version}, older than the ${MIN_RG_MAJOR}.0 seri has verified its --json output against`);
  }

  const probe = spawnSync(command, ["--no-config", "--json", "--", "needle", "-"], {
    input: Buffer.concat([Buffer.from("needle "), Buffer.from([0xe9, 0x0a])]),
    encoding: "utf8",
    timeout: RG_TIMEOUT_MS,
    windowsHide: true,
  });
  const parses = probe.stdout.split("\n").some((line) => {
    try {
      const event = JSON.parse(line) as { type: string; data?: { lines?: { bytes?: string } } };
      return event.type === "match" && typeof event.data?.lines?.bytes === "string";
    } catch {
      return false;
    }
  });
  if (!parses) throw new Error(`${command} is ripgrep ${version} but its --json output is not the shape seri parses`);
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Keyed so a cached binary can never outlive the asset it came from: seri ships exactly one
// vendored rg per release, so a version bump always changes the key, and the asset's size catches
// a developer re-vendoring a different rg without bumping. Hashing the asset instead was measured
// and rejected — SHA-256 over 5.4 MB costs the same order as the 2.80 ms write it would be
// protecting, so it would defeat the cache on every hit; statSync costs 0.033 ms and returns the
// real 5 429 760 even for the compiled build's virtual asset path.
function cachedRgPath(): string {
  const key = `${pkg.version}-${process.platform}-${process.arch}-${statSync(rgAsset).size}`;
  return join(getConfigDir(), "rg", key, process.platform === "win32" ? "rg.exe" : "rg");
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
  try {
    renameSync(tmp, cached);
  } catch (error) {
    rmSync(tmp, { force: true });
    if (!isCachedRg(cached)) throw error;
  }
}

// Verified, not trusted. The rename above makes a short file at this path impossible from an
// interrupted write, but not from a full disk, a botched restore or a half-synced home directory —
// and two stats cost 0.033 ms against running a truncated 5 MB binary.
function isCachedRg(cached: string): boolean {
  return existsSync(cached) && statSync(cached).size === statSync(rgAsset).size;
}

// The first line of `rg --version` is `ripgrep 15.0.0 (rev 3a612f88b8)` — the same shape on the
// vendored 15.0.0, on a 14.1.1 build and on a third-party 15.1.0 fork. Only --selftest and the
// gate below need it, so no ordinary search ever pays for the spawn.
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
  const result = spawnSync(resolveRg().command, ["--no-config", ...args], {
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
    // fixed for. Reachable when the cached binary is removed or quarantined mid-session.
    throw new Error(`failed to run rg: ${result.error.message}`);
  }

  // rg exits 1 when there are no matches (not an error); anything else is a real failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`rg exited with code ${result.status}: ${result.stderr}`);
  }

  return { stdout: result.stdout, truncated: false };
}
