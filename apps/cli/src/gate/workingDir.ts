import { isAbsolute, relative, resolve, sep } from "node:path";
import { foldsCase } from "../caseFold";

// Relative paths resolve against the session cwd, not process.cwd(). A daemon hosts concurrent
// sessions and never calls chdir, so each toolset has to carry its own directory. Shared with the
// FS-boundary classifier so a path the gate allows is the same string the tool opens.
export function resolveAgainstCwd(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function normalize(path: string): string {
  const resolved = resolve(path);
  return foldsCase() ? resolved.toLowerCase() : resolved;
}

// String classification only: exists/stat/realpath would probe the disk before the gate. A
// symlink inside cwd that points outside is therefore still "inside" here.
export function isInsideWorkingDir(cwd: string, path: string): boolean {
  const root = normalize(cwd);
  const target = normalize(resolveAgainstCwd(cwd, path));
  const rel = relative(root, target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  if (rel === "..") return false;
  return !rel.startsWith(`..${sep}`);
}

export type PathLocation = "inside" | "outside";

export function pathLocation(cwd: string, path: string): PathLocation {
  return isInsideWorkingDir(cwd, path) ? "inside" : "outside";
}
