import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function findAgentsFile(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "AGENTS.md");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadAgentsFile(startDir: string): string {
  const path = findAgentsFile(startDir);
  return path ? readFileSync(path, "utf8") : "";
}
