import type { ToolSet } from "ai";
import { READ_ONLY_TOOL_NAMES, type ToolName, toolDefinitions } from "../provider/tools";

export type SubagentRole = "explore" | "plan" | "code" | "test";

// A tuple, not the SubagentRole union directly, so z.enum(DISPATCHABLE_ROLES) (dispatch.ts) can
// type its own input schema off this array. Phase 2's archivist role must stay unreachable from
// the model: it must not be added here even if SubagentRole itself grows to include it.
export const DISPATCHABLE_ROLES = ["explore", "plan", "code", "test"] as const;

// `plan` shares `explore`'s array by reference: read access is identical between the two roles.
const ROLE_TOOL_NAMES: Record<SubagentRole, readonly ToolName[]> = {
  explore: READ_ONLY_TOOL_NAMES,
  plan: READ_ONLY_TOOL_NAMES,
  test: [...READ_ONLY_TOOL_NAMES, "bash", "powershell"],
  code: Object.keys(toolDefinitions) as ToolName[],
};

// Definitions passed by reference, never wrapped — same non-mutating idiom as
// checkpoint/wrapTools.ts's read-only branch. Deliberately NOT withVerification either: a `code`
// child's write_file therefore skips the parent's verify-on-write check, the same way it already
// skips withCheckpoints (dispatch.ts's own pre-dispatch-snapshot comment explains that half).
// Composing verification into a child's ToolSet is a real design question of its own — whether a
// failure should read like the parent's near-miss report, whether it needs its own rewindTo
// reasoning — left as a follow-up rather than decided here.
export function buildRoleToolSet(role: SubagentRole): ToolSet {
  return Object.fromEntries(
    ROLE_TOOL_NAMES[role].map((name) => [name, toolDefinitions[name]]),
  ) as ToolSet;
}

const ROLE_JOB: Record<SubagentRole, string> = {
  explore: "read the codebase and report what you find in text. You cannot write or run commands.",
  plan: "reason toward a change and describe it in text. You cannot write it — that is a separate role.",
  code: "read, write and run commands to make the change.",
  test: "run the project's own checks and report a verdict in text. You cannot fix what fails.",
};

// Appended after the parent's own system-prompt tiers (dispatch.ts's runOne), so every subagent
// gets the same tool guidance the parent's "# Tools" section gives plus this role-specific
// correction to it.
export function roleAddendum(role: SubagentRole): string {
  const names = ROLE_TOOL_NAMES[role].join(", ");
  return (
    `You are a "${role}" subagent: ${ROLE_JOB[role]} You cannot dispatch subagents yourself — the ` +
    `"# Tools" list above overstates what you have; your only tools this run are: ${names}. Your ` +
    `final assistant message is your entire deliverable — nothing else you say is returned to ` +
    `whoever dispatched you.`
  );
}
