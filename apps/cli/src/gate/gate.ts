import { foldsCase } from "../caseFold";
import { classifyBuiltin, type ToolClass } from "../provider/tools";
import { windowsShortPath } from "./win32LongPath";
import { canonicalizeAgainstCwd, matchCandidatesAgainstCwd, resolveAgainstCwd } from "./workingDir";

export type PermissionMode = "read-only" | "approve-each" | "auto";

export type PathDenial = {
  readonly tool: string;
  readonly pattern: string;
};

export type PermissionCheck = {
  readonly input?: unknown;
  readonly denials?: readonly PathDenial[];
  readonly cwd?: string;
  readonly classify?: (name: string) => ToolClass;
};

export function pathFromToolInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function matchPath(path: string): string {
  const posix = path.replaceAll("\\", "/");
  return foldsCase() ? posix.toLowerCase() : posix;
}

function hasUserGlob(path: string): boolean {
  return /[*?]/.test(path);
}

function covers(base: string, tree: boolean, path: string): boolean {
  if (path === base) return true;
  return tree && path.startsWith(`${base}/`);
}

function denialBases(pattern: string, cwd: string): string[] {
  const tree = pattern.endsWith("/**") || pattern.endsWith("\\**");
  const raw = tree ? pattern.slice(0, -3) : pattern;
  const lexical = resolveAgainstCwd(cwd, raw);
  const canonical = canonicalizeAgainstCwd(cwd, lexical);
  const bases = [canonical, lexical];
  for (const form of [canonical, lexical]) {
    const short = windowsShortPath(form);
    if (short !== undefined) bases.push(short);
  }
  return [...new Set(bases.map(matchPath))];
}

export function pathMatchesDenial(pattern: string, path: string, cwd?: string): boolean {
  const root = cwd ?? ".";
  const tree = pattern.endsWith("/**") || pattern.endsWith("\\**");
  const base = tree ? pattern.slice(0, -3) : pattern;
  const glob = hasUserGlob(base)
    ? new Bun.Glob(matchPath(resolveAgainstCwd(root, pattern)))
    : undefined;
  const bases = glob === undefined ? denialBases(pattern, root) : [];
  for (const candidate of matchCandidatesAgainstCwd(root, path)) {
    const folded = matchPath(candidate);
    if (glob?.match(folded) === true) return true;
    if (bases.some((denialBase) => covers(denialBase, tree, folded))) return true;
  }
  return false;
}

export function denialBlocks(
  denials: readonly PathDenial[] | undefined,
  toolName: string,
  input: unknown,
  cwd?: string,
): boolean {
  if (denials === undefined || denials.length === 0) return false;
  const path = pathFromToolInput(input);
  if (path === undefined) return false;
  return denials.some(
    (denial) => denial.tool === toolName && pathMatchesDenial(denial.pattern, path, cwd),
  );
}

export function checkPermission(
  toolName: string,
  mode: PermissionMode,
  allowedTools?: ReadonlySet<string>,
  check?: PermissionCheck,
): "allow" | "block" | "needs-approval" {
  if (denialBlocks(check?.denials, toolName, check?.input, check?.cwd)) return "block";
  const classify = check?.classify ?? classifyBuiltin;
  if (classify(toolName) === "read") return "allow";
  if (mode === "auto") return "allow";
  if (mode === "read-only") return "block";
  return allowedTools?.has(toolName) === true ? "allow" : "needs-approval";
}

export function cycleMode(mode: PermissionMode): PermissionMode {
  if (mode === "read-only") return "approve-each";
  if (mode === "approve-each") return "auto";
  return "read-only";
}
