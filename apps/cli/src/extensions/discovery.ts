import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldsCase } from "../caseFold";
import { getBaseConfigDir } from "../config/paths";




export type ExtensionSource = "user" | "project";

export type ExtensionScope = { readonly dir: string; readonly source: ExtensionSource };













export function findProjectExtensionDir(startDir: string, dirname_: string): string | undefined {
  // NTFS/APFS: cwd casing and $HOME casing are routinely different spellings of the same path.
  const fold = (path: string): string => (foldsCase() ? path.toLowerCase() : path);
  const globalDefault = fold(join(getBaseConfigDir(), dirname_));
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".seri", dirname_);
    if (fold(candidate) !== globalDefault && existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}




export function extensionScopes(opts: {
  worktree: string;
  configDir: string;
  dirname: string;
}): readonly ExtensionScope[] {
  const scopes: ExtensionScope[] = [{ dir: join(opts.configDir, opts.dirname), source: "user" }];
  const projectDir = findProjectExtensionDir(opts.worktree, opts.dirname);
  if (projectDir !== undefined) scopes.push({ dir: projectDir, source: "project" });
  return scopes;
}
