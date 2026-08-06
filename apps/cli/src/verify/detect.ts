import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type CheckCommand = { cwd: string; script: "typecheck" | "lint" };

function readScripts(packagePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
    return typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>) : null;
  } catch {
    // A half-written package.json is a normal state for a repo an agent is editing, and a check
    // that cannot be detected is already a supported outcome — so this degrades to "no check"
    // rather than turning a cosmetic failure into a failed write.
    return null;
  }
}

// Resolved from the WRITTEN FILE, not from the project root, and that is the cost decision the
// whole feature turns on. Measured in this repo: the root `typecheck` chains eight workspaces at
// 20.3 s cold / 17.2 s warm, where `apps/cli`'s own is 3.6 s. Per write, six times over, that is
// the difference between affordable and not.
//
// The nearest package.json is also the LAST one consulted: if it declares neither script, the walk
// stops rather than continuing to an ancestor. An outer workspace's `typecheck` covers its own
// sources, not this one's, so running it would report a green that says nothing about the file
// just written — the failure mode the risk table names as "model trusts a false green".
export function detectCheckCommand(filePath: string): CheckCommand | null {
  let dir = dirname(resolve(filePath));

  for (;;) {
    const packagePath = resolve(dir, "package.json");
    if (existsSync(packagePath)) {
      const scripts = readScripts(packagePath);
      if (typeof scripts?.typecheck === "string") return { cwd: dir, script: "typecheck" };
      if (typeof scripts?.lint === "string") return { cwd: dir, script: "lint" };
      return null;
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
