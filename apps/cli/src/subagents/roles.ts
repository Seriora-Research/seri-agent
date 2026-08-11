import type { ToolSet } from "ai";
import {
  FS_MUTATING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  type ToolName,
  toolDefinitions,
} from "../provider/tools";

// "archivist" (Phase 2) is a member of this union but deliberately absent from DISPATCHABLE_ROLES
// below — see that const's own comment for why that, not this type, is the enforcement point.
export type SubagentRole = "explore" | "plan" | "code" | "test" | "archivist";

// A tuple, not the SubagentRole union directly, so z.enum(DISPATCHABLE_ROLES) (dispatch.ts) can
// type its own input schema off this array. Phase 2's archivist role must stay unreachable from
// the model: it is not added here even though SubagentRole itself now includes it — the archivist
// is dispatched directly by memory/archivist.ts via runSubagent (dispatch.ts's own comment on that
// function), never through the model-facing dispatch_subagents tool.
export const DISPATCHABLE_ROLES = ["explore", "plan", "code", "test"] as const;

// The one tool a role can be given that is NOT a key of toolDefinitions — memory_write
// (memory/tool.ts), deliberately absent from toolDefinitions/ToolName (provider/tools.ts's own
// comment) so no DISPATCHABLE_ROLES role can ever be handed it by name alone. buildRoleToolSet's
// own `extraTools` parameter is the only way a ToolSet can contain it.
type ExtraToolName = "memory_write";

// `plan` shares `explore`'s array by reference: read access is identical between the two roles.
const ROLE_TOOL_NAMES: Record<SubagentRole, readonly (ToolName | ExtraToolName)[]> = {
  explore: READ_ONLY_TOOL_NAMES,
  plan: READ_ONLY_TOOL_NAMES,
  test: [...READ_ONLY_TOOL_NAMES, "bash", "powershell"],
  code: Object.keys(toolDefinitions) as ToolName[],
  archivist: ["memory_write"],
};

// Definitions passed by reference, never wrapped — same non-mutating idiom as
// checkpoint/wrapTools.ts's read-only branch. Deliberately NOT withVerification either: a `code`
// child's write_file therefore skips the parent's verify-on-write check, the same way it already
// skips withCheckpoints (dispatch.ts's own pre-dispatch-snapshot comment explains that half).
// Composing verification into a child's ToolSet is a real design question of its own — whether a
// failure should read like the parent's near-miss report, whether it needs its own rewindTo
// reasoning — left as a follow-up rather than decided here.
//
// `extraTools` resolves a role's names against toolDefinitions AND this map — Phase 2's seam for
// memory_write, which is not a key of toolDefinitions at all. Every DISPATCHABLE_ROLES call site
// (dispatch.ts's runOne) passes none and gets today's behaviour unchanged; only memory/archivist.ts
// passes one.
export function buildRoleToolSet(role: SubagentRole, extraTools: ToolSet = {}): ToolSet {
  const available: Record<string, ToolSet[string]> = { ...toolDefinitions, ...extraTools };
  return Object.fromEntries(
    ROLE_TOOL_NAMES[role].map((name) => [name, available[name]]),
  ) as ToolSet;
}

// A role needs the pre-dispatch checkpoint and gets serialized against every other mutating-tool
// role if it holds ANY tool in FS_MUTATING_TOOL_NAMES — derived from the role's own grant, not a
// role-name list, so a future role gaining bash does not silently skip either guard.
export function roleMutatesFilesystem(role: SubagentRole): boolean {
  return ROLE_TOOL_NAMES[role].some((name) =>
    (FS_MUTATING_TOOL_NAMES as readonly string[]).includes(name),
  );
}

// Required for every SubagentRole, "archivist" included, so this Record stays total — but
// roleAddendum is never actually called for "archivist" (memory/archivist.ts builds its own
// standalone system prompt, ARCHIVIST_PROMPT below, instead of composing onto a parent's system
// the way the four DISPATCHABLE_ROLES do via dispatch.ts's runOne).
const ROLE_JOB: Record<SubagentRole, string> = {
  explore: "read the codebase and report what you find in text. You cannot write or run commands.",
  plan: "reason toward a change and describe it in text. You cannot write it — that is a separate role.",
  code: "read, write and run commands to make the change.",
  test: "run the project's own checks and report a verdict in text. You cannot fix what fails.",
  archivist: "consolidate memory writes from a transcript. You have no other tools.",
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

// The archivist's ENTIRE system prompt, not an addendum composed onto a parent's (unlike the four
// DISPATCHABLE_ROLES above): the archivist has no coding-agent identity to inherit — its only job
// is deciding what belongs in memory and writing it with memory_write, so memory/archivist.ts
// passes this directly as runSubagent's `system`, never joinTiers'd with anything else.
export const ARCHIVIST_PROMPT = `You are seri's archivist. You are handed the transcript of a completed stretch of a
coding session and the current contents of the three memory files. Your only job is to decide what
in that transcript is worth remembering, and to record it with memory_write. You have no other
tools: you cannot read files, search, run commands, or edit anything.

Write a fact only if it will still be true and still be useful in a session next week. Corrections
the user made, conventions of this repo, commands that work here, and stated preferences qualify.
Do not record what happened in this session, what you did, or anything the conversation itself
already carries.

Choose the scope by authority, not by topic: a preference is "user" unless it is stated or enforced
as a requirement of one specific repository, in which case it goes in "memory-project" — even when
it is phrased as a preference. When a project requirement contradicts a "user" default, record the
exception in "memory-project"; never edit "user" to carve out a project-specific exception.
Cross-project environment facts go in "memory-global".

Every file has a hard character cap and a write that would exceed it is refused, listing the
current entries. When that happens, consolidate: "replace" two overlapping entries with one, or
"remove" one that a newer fact has invalidated. Never restate a fact already recorded.

Every call also requires "reason" (one short phrase: which turn or fact in the transcript triggered
this write — not a restatement of the entry itself) and "durable" (true if this will still be true
and useful next week, false if you judge it session-scoped but still worth recording provisionally).
A human reviews these alongside your write before it takes effect.`;
