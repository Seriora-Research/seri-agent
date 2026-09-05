import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { grep } from "./grep";
import { resolveRg, rgVersion } from "./runRipgrep";

export async function probeRipgrep(grepFn: typeof grep): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "seri-selftest-"));
  try {
    writeFileSync(join(dir, "probe.txt"), "seri selftest probe\n");
    const { matches = [] } = await grepFn("selftest probe", { path: dir, mode: "content" });
    if (matches.length !== 1) {
      throw new Error(`ripgrep returned ${matches.length} matches, expected 1`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return rgVersion(resolveRg());
}
