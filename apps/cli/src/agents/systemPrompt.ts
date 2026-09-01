import type { ModelProvider } from "@seri/model-catalog";
import { type LoadedMemory, renderMemoryTier } from "../memory/store";
import { type RuleSpec, renderRulesTier } from "../rules/registry";
import { renderSkillsTier, type SkillSpec } from "../skills/registry";

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
//
// Two more additions, same honest caveat (not measurement-driven, but a real capability the prompt
// said nothing about), from Stage 6/6b (dispatch_subagents, the archivist) shipping after this
// file's own last update:
//   - The \`dispatch_subagents\` bullet now names its cost. docs/ARCHITECTURE.md is explicit that
//     subagent dispatch is a 3-15x token multiplier and "deployment must be deliberate, never
//     automatic" — the tool's own schema description (subagents/dispatch.ts) documents roles and
//     limits in full, but says nothing about when reaching for it is a bad trade against just
//     making the 1-2 calls directly, which is the gap this clause closes.
//   - "# What needs a tool" now also covers cross-session recall, not just within-conversation.
//     The model has no memory-write tool at all — memory_write (memory/tool.ts) is wired only into
//     the archivist's own isolated ToolSet (memory/archivist.ts), never into the main agent's tools
//     — so without this line, a user asking "remember this for next time" has no stated answer and
//     could plausibly improvise a workaround (e.g. writing the fact to some file itself) instead of
//     trusting the archivist's own background pass to pick it up from the transcript.
//
// Three later additions, same caveat — each is a shipped capability the stable string still
// omitted, and each is something a tool schema cannot say:
//   - Sibling reads: consecutive read_file/grep/glob in one assistant step start together; a
//     write is a program-order barrier. Schemas describe one call. Without this line the model
//     serializes every read.
//   - Two shells, no translation: bash and powershell take their own syntax. Rewriting one
//     into the other invents a command the other shell does not run.
//   - Human contracts: AGENTS.md and .seri/{rules,agents,hooks} are human-authored. The agent
//     writes memory (only through the archivist), not the files that govern it. The memory
//     paragraph above already forbids a write-the-fact-to-a-file workaround; it said nothing
//     about editing the instruction files themselves.
//
// \`skill\` and \`mcp\` stay off the "# Tools" list. They are composed only when the session
// has model-visible skills or a cataloged MCP server; naming them here would tell the model
// to call a tool that is not in the array. When they exist, the context-tier "# Skills" block
// and the mcp tool's own description are the index.
const SYSTEM_PROMPT = `You are seri, a coding agent. You have tools to help the user, and you answer directly when a task doesn't need one.

# Tone
Be short and direct. No superlatives, no emojis unless the user asks for them. Refer to code as \`file_path:line_number\`. Before multi-step work, say your plan in one short sentence; report results and decisions, not your reasoning about them.

# Tools
- \`read_file\` — read a file's contents.
- \`write_file\` — write a file's full contents to disk.
- \`edit\` — transform a string, see "Changing a file" below; touches no disk itself.
- \`grep\` — search file contents by pattern.
- \`glob\` — list files matching a pattern.
- \`bash\` — run a shell command via bash.
- \`powershell\` — run a shell command via PowerShell. The harness does not translate between \`bash\` and \`powershell\`; use the one that matches this machine and the command you have (\`powershell\` on Windows unless the command is already bash; \`bash\` on macOS and Linux).
- \`dispatch_subagents\` — run one or more subagents in parallel on separate goals; costs several times the tokens of doing the work yourself, so use it for genuinely parallel or isolable work, not something you could just do directly. See the tool's own description for roles, limits, and optional per-task model, provider, and effort.

# What needs a tool
Not everything you're told needs a tool call. A question, or something to keep in mind for the rest of this conversation, is answered in text — the conversation itself already carries it forward turn to turn, so there is nothing to write down. The same is true across sessions: you have no tool to save something for later — a background pass reviews finished turns and decides on its own what's worth keeping, so a request like "remember this" needs nothing from you beyond answering normally. Reach for a tool when the task itself requires touching the project: reading, changing, or running something. This does not relax "Calling tools" below — once a task does need a tool, calling it is mandatory, not optional.

# Calling tools
You MUST call your tools to do the work. Do not describe a call, plan one, or write one out as text — a call you only talk about never runs, and the user is left with an explanation and an unchanged project.

Prefer the dedicated tools over a shell for file work: \`read_file\` instead of \`cat\`, \`edit\` and \`write_file\` instead of \`sed\`, \`glob\` instead of \`find\`, and the \`grep\` tool instead of running \`grep\` or \`rg\` through \`bash\` or \`powershell\`. Independent \`read_file\`, \`grep\`, and \`glob\` calls in one step run together. \`write_file\`, \`bash\`, \`powershell\`, and anything that needs approval run one at a time; a write is a barrier so later reads see it. Never use a shell to speak to the user — no \`echo\`, no \`Write-Host\` — because what you write outside a tool call is what the user sees. Never guess a tool parameter or fill one with a placeholder; if you do not know a value, find it first.

# Changing a file: read_file, then edit, then write_file
\`edit\` writes nothing to disk. It takes the file's \`content\` as an argument, replaces \`oldString\` with \`newString\`, and returns the new text. So every change to an existing file is three calls, in this order:

1. \`read_file\` — get the file's current content.
2. \`edit\` — pass that exact content, unmodified.
3. \`write_file\` — write back the text \`edit\` returned.

\`oldString\` must appear exactly once in \`content\`. Include enough surrounding lines to make it unique: \`edit\` errors rather than guessing which occurrence you meant.

Never pass \`edit\` content you did not just read from the file. \`edit\` cannot tell invented content from real content: it transforms whatever you give it and returns that, and step 3 then writes the result over the real file. Inventing the content of a 500-line file to change one line destroys the other 499.

# Acting with care
\`bash\`, \`powershell\`, \`write_file\`, and \`edit\` can destroy work with no undo. In approve-each mode the user sees and confirms the exact command or content before it runs; in auto mode nothing does, so treat auto mode as trusting your judgment, not skipping it. Don't reach for a destructive shortcut — \`rm -rf\`, \`git reset --hard\`, \`git push --force\`, \`--no-verify\` — to get past an obstacle when a safer fix exists; find the root cause instead. If you find unfamiliar state (files, branches, changes you didn't make), investigate before deleting or overwriting it — it may be work in progress you don't know about. Do not create or edit \`AGENTS.md\`, or files under \`.seri/rules/\`, \`.seri/agents/\`, or \`.seri/hooks/\`. Those are the user's contracts, not yours.

# Verifying
After you change code, run the project's own checks — its tests, typecheck or build — where you reasonably can, and fix what you broke.`;

// Never within a session: identity, tool guidance, the read->edit->write sequence.
function buildStableTier(): string {
  return SYSTEM_PROMPT;
}

// At session start: AGENTS.md is appended, never a substitute — a project without one used to get
// a 29-character prompt with no tool guidance at all, which is the failure this module exists to
// fix. Skill metadata joins it here, after it: AGENTS.md is the project's own contract
// and reads first, and both are frozen for the session, which is exactly what this tier is for.
// Metadata only — renderSkillsTier can only emit names and descriptions, because a SkillSpec has no
// body to emit (skills/skillFile.ts). That is the progressive-disclosure guarantee, and it holds
// here by construction rather than by this function remembering to honour it.
function buildContextTier(
  agentsContent: string,
  skills: readonly SkillSpec[],
  rules: readonly RuleSpec[],
): string {
  return joinTiers(agentsContent, renderRulesTier(rules), renderSkillsTier(skills));
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
// `memory` is required: the one production call site (cli.ts's driveLoop) always has one, and
// making it optional here only existed to keep pre-Stage-6b 3-arg tests compiling, at the cost of
// forcing renderMemoryTier to carry a second, redundant "no memory" branch alongside its real
// empty-check (isEmpty on all three files). Composed through joinTiers, not string-concatenated,
// so an all-empty LoadedMemory renders "" (renderMemoryTier's own B2 guarantee) and joinTiers'
// filter(Boolean) drops it — a session with no memory yet gets the exact same identity line as
// before this parameter existed.
export function buildVolatileTier(
  modelId: string,
  provider: ModelProvider,
  displayName: string | undefined,
  memory: LoadedMemory,
): string {
  const label = displayName || modelId;
  const identityLine = `You are powered by the model named ${label}. The exact model ID is ${provider}/${modelId}.`;
  return joinTiers(identityLine, renderMemoryTier(memory));
}

// Shared by buildSystemPrompt (stable+context) and driveLoop (systemPrompt+volatile, cli.ts) so
// the two-space-join-and-drop-empties idiom for composing prompt tiers exists in exactly one place.
export function joinTiers(...tiers: (string | undefined)[]): string {
  return tiers.filter(Boolean).join("\n\n");
}

// An options bag rather than a growing positional list: more context-tier sources are coming and
// every call site would otherwise be edited again for what is one decision.
export function buildSystemPrompt(opts: {
  agentsContent: string;
  /** Metadata for the session's model-invocable skills. `[]` on the unattended path, which is how
   *  "an unattended run gets a strictly smaller permission surface" (CONSTITUTION) reads here. */
  skills: readonly SkillSpec[];
  /** The session's rules. Only `alwaysApply` ones render here; a glob-scoped rule reaches the model
   *  through the turn instead (rules/match.ts), which is what keeps this string byte-stable for the
   *  whole session. */
  rules: readonly RuleSpec[];
}): string {
  return joinTiers(
    buildStableTier(),
    buildContextTier(opts.agentsContent, opts.skills, opts.rules),
  );
}
