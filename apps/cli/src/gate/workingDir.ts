import { isAbsolute, relative, resolve, sep } from "node:path";
import { foldsCase } from "../caseFold";

// A daemon hosts concurrent sessions and never calls chdir, so each toolset has to carry its own
// directory.
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

export const PATH_BEARING_FS_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "grep",
  "glob",
  "write_file",
]);

export type CallLocation = "inside" | "outside" | "nopath";

function pathFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  if (!("path" in input)) return undefined;
  const path = (input as { path: unknown }).path;
  return typeof path === "string" ? path : undefined;
}

// String classification only: a missing or non-string path on a path-bearing tool is outside
// (fail closed). An empty cwd is the same hole as a forgotten one.
export function locationForCall(cwd: string, toolName: string, input: unknown): CallLocation {
  if (!PATH_BEARING_FS_TOOLS.has(toolName)) return "nopath";
  const path = pathFromInput(input);
  if (path === undefined || cwd === "") return "outside";
  return pathLocation(cwd, path);
}
