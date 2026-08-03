import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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
const rgPath = join(rgDir, process.platform === "win32" ? "rg.exe" : "rg");
writeFileSync(rgPath, bytes);
if (process.platform !== "win32") chmodSync(rgPath, 0o755);

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
export const MAX_RESULTS = 100;

export function runRipgrep(args: string[]): { stdout: string; truncated: boolean } {
  // --no-config: rg reads RIPGREP_CONFIG_PATH from the environment, so without this a
  // developer's own ~/.ripgreprc (--smart-case, --hidden, glob excludes) silently changes
  // what hesper finds on their machine and nowhere else.
  const result = spawnSync(rgPath, ["--no-config", ...args], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
  });

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
    return { stdout: result.stdout, truncated: true };
  }

  // rg exits 1 when there are no matches (not an error); anything else is a real failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`rg exited with code ${result.status}: ${result.stderr}`);
  }

  return { stdout: result.stdout, truncated: false };
}
