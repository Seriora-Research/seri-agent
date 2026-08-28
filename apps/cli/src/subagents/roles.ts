import type { ToolSet } from "ai";
import { type OnAfterMutation, withMutationRecording } from "../checkpoint/wrapTools";
import {
  FS_MUTATING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  type ToolName,
  createToolDefinitions,
  toolDefinitions,
} from "../provider/tools";

export type SubagentRole = "explore" | "plan" | "code" | "test" | "oracle";

// A tuple, not the SubagentRole union directly, so z.enum(DISPATCHABLE_ROLES) (dispatch.ts) can
// type its own input schema off this array. The archivist is a routing target, not a parent-callable
// role: it must not be added here even if a future RoutableRole list grows to include it.
export const DISPATCHABLE_ROLES = ["explore", "plan", "code", "test", "oracle"] as const;

// `plan` and `oracle` share `explore`'s array by reference: read access is identical among the
// three. Oracle is still a distinct seat — isolated context and a different addendum — not a
// second explorer.
const ROLE_TOOL_NAMES: Record<SubagentRole, readonly ToolName[]> = {
  explore: READ_ONLY_TOOL_NAMES,
  plan: READ_ONLY_TOOL_NAMES,
  oracle: READ_ONLY_TOOL_NAMES,
  test: [...READ_ONLY_TOOL_NAMES, "bash", "powershell"],
  code: Object.keys(toolDefinitions) as ToolName[],
};

// Definitions passed by reference, never wrapped with the full withCheckpoints — same non-mutating
// idiom as checkpoint/wrapTools.ts's read-only branch. Deliberately NOT withVerification either: a
// `code` child's write_file therefore skips the parent's verify-on-write check, the same way it
// skips withCheckpoints' pre-mutation snapshot (dispatch.ts's own pre-dispatch-snapshot comment
// explains that half). Composing verification into a child's ToolSet is a real design question of
// its own — whether a failure should read like the parent's near-miss report, whether it needs its
// own rewindTo reasoning — left as a follow-up rather than decided here.
//
// `onAfterMutation` IS applied, via withMutationRecording rather than withCheckpoints, when the
// caller has one — this is the write-ledger half only (see wrapTools.ts's own comment on why the
// two halves are separable): a subagent's write_file still needs to be recorded so a later /undo
// can prove it safe to delete, even though nothing about the pre-mutation snapshot applies here.
export function buildRoleToolSet(
  role: SubagentRole,
  onAfterMutation?: OnAfterMutation,
  cwd = process.cwd(),
): ToolSet {
  const definitions = createToolDefinitions(cwd);
  const tools = Object.fromEntries(
    ROLE_TOOL_NAMES[role].map((name) => [name, definitions[name]]),
  ) as ToolSet;
  return onAfterMutation === undefined ? tools : withMutationRecording(tools, onAfterMutation);
}

// A role needs the pre-dispatch checkpoint and gets serialized against every other mutating-tool
// role if it holds ANY tool in FS_MUTATING_TOOL_NAMES — derived from the role's own grant, not a
// role-name list, so a future role gaining bash does not silently skip either guard.
export function roleMutatesFilesystem(role: SubagentRole): boolean {
  return ROLE_TOOL_NAMES[role].some((name) =>
    (FS_MUTATING_TOOL_NAMES as readonly string[]).includes(name),
  );
}

const ROLE_JOB: Record<SubagentRole, string> = {
  explore: "read the codebase and report what you find in text. You cannot write or run commands.",
  plan: "reason toward a change and describe it in text. You cannot write it — that is a separate role.",
  oracle: "advise as a senior engineer. You cannot write or run commands.",
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
