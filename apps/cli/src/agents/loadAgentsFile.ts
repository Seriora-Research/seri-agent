import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getBaseConfigDir } from "../config/paths";

const AGENTS_FILENAME = "AGENTS.md";

// Repo-local is the git root's AGENTS.md, or startDir itself when there is no repo.
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

function localRoot(startDir: string): string {
  return findGitRoot(startDir) ?? resolve(startDir);
}

export function findAgentsFile(startDir: string): string | undefined {
  const local = join(localRoot(startDir), AGENTS_FILENAME);
  if (existsSync(local)) return local;
  const global = join(getBaseConfigDir(), AGENTS_FILENAME);
  if (existsSync(global)) return global;
  return undefined;
}

export function loadAgentsFile(startDir: string): string {
  const path = findAgentsFile(startDir);
  return path ? readFileSync(path, "utf8") : "";
}
