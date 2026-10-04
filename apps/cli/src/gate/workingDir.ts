import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { foldsCase } from "../caseFold";

const MAX_SYMLINKS = 64;

export function resolveAgainstCwd(cwd: string, path: string): string {
  return resolve(cwd, path);
}

function stripWindowsLongPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

function concatRaw(base: string, rel: string): string {
  if (rel.length === 0) return base;
  if (base.endsWith("/") || base.endsWith("\\")) return base + rel;
  return `${base}${sep}${rel}`;
}

function joinRaw(base: string, rel: string): string {
  return rel.length === 0 ? base : concatRaw(base, rel);
}

function splitPath(path: string): { root: string; parts: string[] } {
  const parsed = parse(path);
  const rest = path.slice(parsed.root.length);
  const parts = rest.split(/[\\/]/).filter((part) => part.length > 0);
  return { root: parsed.root, parts };
}

function popPath(path: string): string {
  const { root, parts } = splitPath(path);
  if (parts.length <= 1) return root.length > 0 ? root : sep;
  return join(root, ...parts.slice(0, -1));
}

function realpathExisting(path: string): string {
  const nativeRealpath = realpathSync.native;
  if (typeof nativeRealpath === "function") {
    try {
      return stripWindowsLongPath(nativeRealpath(path));
    } catch {
      // Some prefixes exist for lstat but not for the native realpath.
    }
  }
  return stripWindowsLongPath(realpathSync(path));
}

export function canonicalizeAgainstCwd(cwd: string, path: string): string {
  const absCwd = isAbsolute(cwd) ? cwd : resolve(cwd);
  const absPath = isAbsolute(path) ? path : concatRaw(absCwd, path);
  return walk(absPath, 0);
}

function walk(path: string, depth: number): string {
  if (depth > MAX_SYMLINKS) return stripWindowsLongPath(path);
  const { root, parts } = splitPath(path);
  let current = root.length > 0 ? root : sep;
  try {
    current = realpathExisting(current);
  } catch {
    // C: on POSIX tests, or a volume root the kernel will not resolve.
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined || part === ".") continue;
    if (part === "..") {
      current = popPath(current);
      continue;
    }
    const next =
      current.endsWith(sep) || current.endsWith("/") ? `${current}${part}` : join(current, part);
    try {
      current = realpathExisting(next);
      continue;
    } catch {
      // Missing, or a dangling symlink whose target still has to be followed.
    }
    try {
      if (lstatSync(next).isSymbolicLink()) {
        const target = readlinkSync(next);
        const rest = parts.slice(i + 1).join(sep);
        const resolved = isAbsolute(target) ? target : concatRaw(current, target);
        return walk(joinRaw(resolved, rest), depth + 1);
      }
    } catch {
      // Not a dangling link. Append the missing suffix lexically.
    }
    return join(current, ...parts.slice(i));
  }
  return stripWindowsLongPath(current);
}

function normalize(path: string): string {
  return foldsCase() ? path.toLowerCase() : path;
}

export function isInsideWorkingDir(cwd: string, path: string): boolean {
  const root = normalize(canonicalizeAgainstCwd(cwd, "."));
  const target = normalize(canonicalizeAgainstCwd(cwd, path));
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

export function locationForCall(cwd: string, toolName: string, input: unknown): CallLocation {
  if (!PATH_BEARING_FS_TOOLS.has(toolName)) return "nopath";
  const path = pathFromInput(input);
  if (path === undefined || cwd === "") return "outside";
  return pathLocation(cwd, path);
}
