import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { foldsCase } from "../caseFold";
import { expandWindowsShortNames, hasWindowsShortName } from "./win32LongPath";

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
  const parts =
    process.platform === "win32"
      ? rest.split(/[\\/]/).filter((part) => part.length > 0)
      : rest.split("/").filter((part) => part.length > 0);
  return { root: parsed.root, parts };
}

function popPath(path: string): string {
  const { root, parts } = splitPath(path);
  if (parts.length <= 1) return root.length > 0 ? root : sep;
  return join(root, ...parts.slice(0, -1));
}

function realpathExisting(path: string): string {
  let resolved: string | undefined;
  if (process.platform === "win32") {
    const prefixed = path.startsWith("\\\\?\\") ? path : `\\\\?\\${path}`;
    try {
      resolved = stripWindowsLongPath(realpathSync.native(prefixed));
    } catch {}
  }
  if (resolved === undefined) {
    const nativeRealpath = realpathSync.native;
    if (typeof nativeRealpath === "function") {
      try {
        resolved = stripWindowsLongPath(nativeRealpath(path));
      } catch {}
    }
  }
  if (resolved === undefined) resolved = stripWindowsLongPath(realpathSync(path));
  return hasWindowsShortName(resolved) ? expandWindowsShortNames(resolved) : resolved;
}

function absAgainstCwd(cwd: string, path: string): string {
  const absCwd = isAbsolute(cwd) ? cwd : resolve(cwd);
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) return resolve(absCwd, path);
  return concatRaw(absCwd, path);
}

export function canonicalizeAgainstCwd(cwd: string, path: string): string {
  return walk(absAgainstCwd(cwd, path), 0);
}

export function canonicalizeEntryAgainstCwd(cwd: string, path: string): string {
  return entryOfAbs(absAgainstCwd(cwd, path));
}

export function canonicalizeEntryResolvedAgainstCwd(cwd: string, path: string): string {
  return entryOfAbs(resolveAgainstCwd(cwd, path));
}

function entryOfAbs(abs: string): string {
  const parent = dirname(abs);
  const base = basename(abs);
  if (base === "" || parent === abs) return walk(abs, 0);
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      return join(walk(parent, 0), base);
    }
  } catch {}
  return walk(abs, 0);
}

function formsAgainstCwd(cwd: string, path: string): { target: string; namespace: string } {
  const abs = resolveAgainstCwd(cwd, path);
  const target = walk(abs, 0);
  const parent = dirname(abs);
  const base = basename(abs);
  if (base === "" || parent === abs) return { target, namespace: target };
  try {
    // writeFile's rename replaces this final symlink; the target is still the
    // path a follow would mutate, so callers must check both forms.
    if (lstatSync(abs).isSymbolicLink()) {
      return { target, namespace: join(walk(parent, 0), base) };
    }
  } catch {}
  return { target, namespace: target };
}

function walk(path: string, depth: number): string {
  if (depth > MAX_SYMLINKS) return stripWindowsLongPath(path);
  const { root, parts } = splitPath(path);
  let current = root.length > 0 ? root : sep;
  try {
    current = realpathExisting(current);
  } catch {}
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
    } catch {}
    try {
      if (lstatSync(next).isSymbolicLink()) {
        const target = readlinkSync(next);
        const rest = parts.slice(i + 1).join(sep);
        const resolved = isAbsolute(target) ? target : concatRaw(current, target);
        return walk(joinRaw(resolved, rest), depth + 1);
      }
    } catch {}
    return expandIfShort(join(current, ...parts.slice(i)));
  }
  return expandIfShort(stripWindowsLongPath(current));
}

function expandIfShort(path: string): string {
  return hasWindowsShortName(path) ? expandWindowsShortNames(path) : path;
}

function normalize(path: string): string {
  return foldsCase() ? path.toLowerCase() : path;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  if (rel === "..") return false;
  return !rel.startsWith(`..${sep}`);
}

export function isInsideWorkingDir(cwd: string, path: string): boolean {
  const root = normalize(walk(resolve(cwd), 0));
  const { target, namespace } = formsAgainstCwd(cwd, path);
  return contained(root, normalize(target)) && contained(root, normalize(namespace));
}

export function isEntryInsideWorkingDir(cwd: string, path: string): boolean {
  const root = normalize(walk(resolve(cwd), 0));
  const { target, namespace } = formsAgainstCwd(cwd, path);
  if (namespace !== target) return contained(root, normalize(namespace));
  const posix = canonicalizeAgainstCwd(cwd, path);
  return contained(root, normalize(target)) && contained(root, normalize(posix));
}

export function matchCandidatesAgainstCwd(cwd: string, path: string): readonly string[] {
  const lexical = resolveAgainstCwd(cwd, path);
  const { target, namespace } = formsAgainstCwd(cwd, path);
  return [...new Set([lexical, target, namespace, expandWindowsShortNames(lexical)])];
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
