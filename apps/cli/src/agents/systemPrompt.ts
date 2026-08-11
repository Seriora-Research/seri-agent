import type { ModelProvider } from "@seri/model-catalog";

// One prompt for every model, deliberately: routing a different prompt per model family is what
// both references do (OpenCode selects a file, Hermes injects a block for GPT/Codex only) and it is
// deferred to Stage 7a, when a catalog exists to route on — see docs/PROMPT-ROUTING.md. Until then
// every model gets the enforcement instruction, because the model that needs it is the default.
//
// Three sections are measurement-driven — they exist because of a failure that was observed, and
// deleting them would undo a fix:
//   - "# What needs a tool" — the measured symptom, from a live session (Llama 3.3 70B via Groq):
//     asked to remember a number for the rest of the conversation, the model called `write_file`
//     and created a file for it, unprompted — the conversation history already carries that number
//     forward every turn (loop.ts resends the full `messages` array each turn; nothing needed
//     writing). Placed BEFORE "# Calling tools" and worded as a scope gate ("does this task need a
//     tool at all"), never touching "# Calling tools"'s own text, because that section's mandate
//     ("you MUST call your tools") is the fix for the opposite failure — a model that only
//     describes a needed call instead of making it. Read in isolation, "you must call tools" gives
//     a model no signal that it applies only once a tool is actually needed; this section supplies
//     that signal without diluting the mandate it precedes.
//   - "# Calling tools" — the measured symptom. The model emits `<function/write_file({...})>` as
//     assistant text and the loop ends `done: no-tool-call` having done nothing. "Never talk to the
//     user through bash/powershell" is the same category: text outside a tool call is the only
//     channel the user actually reads.
//   - "# Changing a file" — `edit` (tools/edit.ts) is a pure string transform that takes `content`
//     as an argument and writes nothing, which no other harness ships and no model can guess. A
//     model that invents `content` gets `✓ edit done` and leaves the file untouched
//     (.claude/loops/_archive/cli-manual-test-defects/) — and then write_file, step 3 of the very
//     sequence this section teaches, puts the invention on disk over the real file.
//
//     This is prompt text doing a job the tool cannot: opencode and Claude Code both enforce
//     read-before-modify in the tool itself ("This tool will error if you attempt an edit without
//     reading the file"), which is strictly stronger than asking. seri's `edit` is handed `content`
//     rather than a path, so it has nothing to check against; `write_file` does, and enforcing it
//     there is the real fix. Filed as follow-up, not done here — it changes tool behaviour, and
//     this branch is a prompt change.
//
// "# Tone" and "# Verifying" are structural, not measurement-driven: identity and tone are what the
// product's owner asked the agent to have, and verification is ordinary agent hygiene. No live
// number defends either. But note before cutting them that the 20/20 tool-calling rate recorded in
// docs/PROMPT-ROUTING.md was measured with this prompt whole — remove a section and the shipped
// prompt is no longer the one the evidence describes.
//
// "# Tools" and "# Acting with care" were added adapting CLAUDE-CODE-SYSTEM-PROMPT.md (a
// reconstruction of Claude Code's own system prompt, written to compare harnesses). Neither is
// measurement-driven either — same honest caveat as "# Tone" and "# Verifying" above:
//   - "# Tools" is a one-line-per-tool orientation list using seri's own tool names. Each tool's
//     schema description (provider/tools.ts) already carries this information to the model, so this
//     is deliberately terse — a name-plus-purpose index, not a restatement of "# Changing a file"'s
//     walkthrough of edit/write_file.
//   - "# Acting with care" adapts Claude Code's "Executing actions with care" section, condensed.
//     seri's bash/powershell/write_file/edit tools are genuinely destructive-capable and the prompt
//     previously said nothing about risk, which is reason enough on its own (capability, not a
//     measured incident). Written to complement, not duplicate, the permission gate: in
//     approve-each mode checkPermission (gate/gate.ts) already blocks write_file/edit/bash/powershell
//     on a live approval prompt that shows the user the exact command or content, and bash/powershell
//     can never be permanently granted there (permissions/store.ts: "a grant keyed on a tool NAME
//     says nothing about what a shell command will do"). auto mode skips that prompt entirely
//     (checkPermission returns "allow" unconditionally), so this section is the only check left on
//     destructive judgment in that mode, and on routing around obstacles destructively — no
//     permission mode catches that either way.
const SYSTEM_PROMPT = `You are seri, a coding agent. You work on the user's project through the tools you are given.

# Tone
Be short and direct. No superlatives, no emojis unless the user asks for them. Refer to code as \`file_path:line_number\`. Before multi-step work, say your plan in one short sentence; report results and decisions, not your reasoning about them.

# Tools
- \`read_file\` — read a file's contents.
- \`write_file\` — write a file's full contents to disk.
- \`edit\` — transform a string, see "Changing a file" below; touches no disk itself.
- \`grep\` — search file contents by pattern.
- \`glob\` — list files matching a pattern.
- \`bash\` — run a shell command via bash.
- \`powershell\` — run a shell command via PowerShell.
- \`dispatch_subagents\` — run one or more subagents in parallel on separate goals; see the tool's own description.

# What needs a tool
Not everything you're told needs a tool call. A question, or something to keep in mind for the rest of this conversation, is answered in text — the conversation itself already carries it forward turn to turn, so there is nothing to write down. Reach for a tool when the task itself requires touching the project: reading, changing, or running something. This does not relax "Calling tools" below — once a task does need a tool, calling it is mandatory, not optional.

# Calling tools
You MUST call your tools to do the work. Do not describe a call, plan one, or write one out as text — a call you only talk about never runs, and the user is left with an explanation and an unchanged project.

Prefer the dedicated tools over a shell for file work: \`read_file\` instead of \`cat\`, \`edit\` and \`write_file\` instead of \`sed\`, \`glob\` instead of \`find\`, and the \`grep\` tool instead of running \`grep\` or \`rg\` through \`bash\` or \`powershell\`. Never use a shell to speak to the user — no \`echo\`, no \`Write-Host\` — because what you write outside a tool call is what the user sees. Never guess a tool parameter or fill one with a placeholder; if you do not know a value, find it first.

# Changing a file: read_file, then edit, then write_file
\`edit\` writes nothing to disk. It takes the file's \`content\` as an argument, replaces \`oldString\` with \`newString\`, and returns the new text. So every change to an existing file is three calls, in this order:

1. \`read_file\` — get the file's current content.
2. \`edit\` — pass that exact content, unmodified.
3. \`write_file\` — write back the text \`edit\` returned.

\`oldString\` must appear exactly once in \`content\`. Include enough surrounding lines to make it unique: \`edit\` errors rather than guessing which occurrence you meant.

Never pass \`edit\` content you did not just read from the file. \`edit\` cannot tell invented content from real content: it transforms whatever you give it and returns that, and step 3 then writes the result over the real file. Inventing the content of a 500-line file to change one line destroys the other 499.

# Acting with care
\`bash\`, \`powershell\`, \`write_file\`, and \`edit\` can destroy work with no undo. In approve-each mode the user sees and confirms the exact command or content before it runs; in auto mode nothing does, so treat auto mode as trusting your judgment, not skipping it. Don't reach for a destructive shortcut — \`rm -rf\`, \`git reset --hard\`, \`git push --force\`, \`--no-verify\` — to get past an obstacle when a safer fix exists; find the root cause instead. If you find unfamiliar state (files, branches, changes you didn't make), investigate before deleting or overwriting it — it may be work in progress you don't know about.

# Verifying
After you change code, run the project's own checks — its tests, typecheck or build — where you reasonably can, and fix what you broke.`;

// Never within a session: identity, tool guidance, the read->edit->write sequence.
function buildStableTier(): string {
  return SYSTEM_PROMPT;
}

// At session start: AGENTS.md is appended, never a substitute — a project without one used to get
// a 29-character prompt with no tool guidance at all, which is the failure this module exists to
// fix. Future hook point: Stage 10 recipe metadata joins this tier alongside AGENTS.md.
function buildContextTier(agentsContent: string): string {
  return agentsContent;
}

// Per turn: tells the model which model/provider it is actually running as this turn, so a live
// `/model` switch is reflected instead of confabulated. Composed outside buildSystemPrompt, at the
// driveLoop call site in cli.ts, where session.model/.provider and the catalog's own lookup for
// this turn are already in scope — kept last-in-string there too, so this is the only tier that
// invalidates a cached prefix.
//
// Takes an already-resolved `displayName` rather than a catalog to look up itself: the caller
// (driveLoop) needs the same catalog entry for the loop's own contextWindowSize, so it does that
// lookup once and hands this function the result instead of each doing an identical scan.
// `displayName || modelId`, not `??`: a catalog entry whose `name` came back `""` (present but
// empty) must still fall back to the raw id — `??` only catches null/undefined, not empty string.
export function buildVolatileTier(
  modelId: string,
  provider: ModelProvider,
  displayName: string | undefined,
): string {
  const label = displayName || modelId;
  return `You are powered by the model named ${label}. The exact model ID is ${provider}/${modelId}.`;
}

// Shared by buildSystemPrompt (stable+context) and driveLoop (systemPrompt+volatile, cli.ts) so
// the two-space-join-and-drop-empties idiom for composing prompt tiers exists in exactly one place.
export function joinTiers(...tiers: (string | undefined)[]): string {
  return tiers.filter(Boolean).join("\n\n");
}

export function buildSystemPrompt(agentsContent: string): string {
  return joinTiers(buildStableTier(), buildContextTier(agentsContent));
}
