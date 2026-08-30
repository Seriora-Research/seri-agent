import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldsCase } from "../caseFold";
import { getBaseConfigDir } from "../config/paths";

// Where a loaded extension came from. Insertion order is precedence order everywhere this is used:
// global first, project second, so "project beats global" is a later `set` on one Map rather than a
// conditional at every lookup.
export type ExtensionSource = "user" | "project";

export type ExtensionScope = { readonly dir: string; readonly source: ExtensionSource };

// The upward walk loadAgentsFile.ts already idiomatises for AGENTS.md, stopping at the first
// ancestor that has the directory. seri reads no other harness's directories: an artifact written
// for another toolset and another load contract auto-loading here is a surprise, not a convenience
// — compatibility lives in the file format, and migrating is copying the files in.
//
// Shared by every `.seri/<dirname>/` artifact rather than copied per artifact: the one candidate this walk must never adopt is subtle enough that a second
// hand-written copy of it would eventually drift. `~/.seri/<dirname>` is the default profile's
// GLOBAL scope. A repository that happens to sit under $HOME would otherwise claim it as its own
// PROJECT scope, and a `--profile work` run would reach the default root's artifacts through it —
// the opposite of the disjoint profile trees a named profile promises. Compared case-folded on
// win32/darwin (caseFold.ts): the cwd's casing and $HOME's casing are routinely different spellings
// of one directory there, and an exact compare would leave the back door open.
export function findProjectExtensionDir(startDir: string, dirname_: string): string | undefined {
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

// The profile root's directory, then the project's, in that order. A scope whose directory does not
// exist is still returned — the caller skips it, which keeps this function a pure path computation
// with no filesystem opinion beyond the walk above.
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
