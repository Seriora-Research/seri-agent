import { WRITE_TOOL_NAMES } from "../provider/tools";

export type PermissionMode = "read-only" | "approve-each" | "auto";

export const WRITE_TOOLS = new Set<string>(WRITE_TOOL_NAMES);

export function checkPermission(toolName: string, mode: PermissionMode): "allow" | "block" | "needs-approval" {
  if (mode === "auto") return "allow";
  if (!WRITE_TOOLS.has(toolName)) return "allow";
  return mode === "read-only" ? "block" : "needs-approval";
}

export function cycleMode(mode: PermissionMode): PermissionMode {
  if (mode === "read-only") return "approve-each";
  if (mode === "approve-each") return "auto";
  return "read-only";
}
