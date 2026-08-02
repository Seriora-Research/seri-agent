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

export function runRipgrep(args: string[]): string {
  const result = spawnSync(rgPath, args, { encoding: "utf8" });
  // rg exits 1 when there are no matches (not an error); anything else is a real failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`rg exited with code ${result.status}: ${result.stderr}`);
  }

  return result.stdout;
}
