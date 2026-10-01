import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getBaseConfigDir } from "../config/paths";

const AGENTS_FILENAME = "AGENTS.md";

// Local search stops at the git root (or startDir when there is no repo).
// Walking past that boundary would load $HOME/AGENTS.md — another tool's file — as if it
// belonged to this project. The only fallback is ~/.seri/AGENTS.md, next to config.json.
function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function localCeiling(startDir: string): string {
  return findGitRoot(startDir) ?? resolve(startDir);
}

export function findAgentsFile(startDir: string): string | undefined {
  const ceiling = localCeiling(startDir);
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, AGENTS_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (dir === ceiling) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const global = join(getBaseConfigDir(), AGENTS_FILENAME);
  return existsSync(global) ? global : undefined;
}

export function loadAgentsFile(startDir: string): string {
  const path = findAgentsFile(startDir);
  return path ? readFileSync(path, "utf8") : "";
}
