import { foldsCase } from "../caseFold";
import { classifyBuiltin, resolveAgainstCwd, type ToolClass } from "../provider/tools";

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

function resolveForMatch(path: string, cwd: string | undefined): string {
  return resolveAgainstCwd(cwd ?? ".", path);
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
  const candidate = matchPath(resolveForMatch(path, cwd));
  return denials.some((denial) => {
    if (denial.tool !== toolName) return false;
    const pattern = matchPath(resolveForMatch(denial.pattern, cwd));
    if (new Bun.Glob(pattern).match(candidate)) return true;
    // Bun.Glob("dir/**") matches "dir/" and "dir/file", not "dir".
    return pattern.endsWith("/**") && candidate === pattern.slice(0, -3);
  });
}

// An allow-list over what a tool IS, not a deny-list over names it might be. `classify` vouches for
// the read class and nothing else, so anything it does not vouch for takes the write path. This
// gate used to read "absent from the write list" as "safe", which is only complete while a
// maintainer reviews every tool that exists; an MCP server names its own. A name nothing recognises
// is now blocked in read-only rather than allowed in all three modes.
//
// The read short-circuit sits ahead of the `auto` check rather than behind it. Behaviour is
// unchanged — auto returned `allow` for a read tool anyway — but the order now reads as the rule
// actually is: a read tool is allowed for what it is, in every mode, and the mode only ever decides
// what happens to a write.
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
