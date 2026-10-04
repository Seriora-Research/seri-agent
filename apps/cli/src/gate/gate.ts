import { foldsCase } from "../caseFold";
import { classifyBuiltin, type ToolClass } from "../provider/tools";
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

function escapeGlobLiteral(path: string): string {
  return path.replaceAll(/[\\*?[\]{}]/g, "\\$&");
}

function hasUserGlob(path: string): boolean {
  return /[*?]/.test(path);
}

function denialGlob(
  pattern: string,
  cwd: string,
): { glob: Bun.Glob; dirExact: string | undefined } {
  const tree = pattern.endsWith("/**") || pattern.endsWith("\\**");
  const base = tree ? pattern.slice(0, -3) : pattern;
  if (hasUserGlob(base)) {
    return { glob: new Bun.Glob(matchPath(resolveAgainstCwd(cwd, pattern))), dirExact: undefined };
  }
  const resolved = matchPath(canonicalizeAgainstCwd(cwd, resolveAgainstCwd(cwd, base)));
  const source = tree ? `${escapeGlobLiteral(resolved)}/**` : escapeGlobLiteral(resolved);
  return { glob: new Bun.Glob(source), dirExact: tree ? resolved : undefined };
}

export function pathMatchesDenial(pattern: string, path: string, cwd?: string): boolean {
  const root = cwd ?? ".";
  const { glob, dirExact } = denialGlob(pattern, root);
  for (const candidate of matchCandidatesAgainstCwd(root, path)) {
    const folded = matchPath(candidate);
    if (glob.match(folded)) return true;
    if (dirExact !== undefined && folded === dirExact) return true;
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
