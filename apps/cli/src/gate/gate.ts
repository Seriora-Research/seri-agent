import { classifyBuiltin, type ToolClass } from "../provider/tools";

export type PermissionMode = "read-only" | "approve-each" | "auto";

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
  classify: (name: string) => ToolClass = classifyBuiltin,
): "allow" | "block" | "needs-approval" {
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
