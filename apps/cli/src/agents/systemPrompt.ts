// One prompt for every model, deliberately: routing a different prompt per model family is what
// both references do (OpenCode selects a file, Hermes injects a block for GPT/Codex only) and it is
// deferred to Stage 7a, when a catalog exists to route on — see docs/PROMPT-ROUTING.md. Until then
// every model gets the enforcement instruction, because the model that needs it is the default.
//
// Two sections are measurement-driven — they exist because of a failure that was observed, and
// deleting them would undo a fix:
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
const SYSTEM_PROMPT = `You are seri, a coding agent. You work on the user's project through the tools you are given.

# Tone
Be short and direct. No superlatives, no emojis unless the user asks for them. Refer to code as \`file_path:line_number\`.

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

# Verifying
After you change code, run the project's own checks — its tests, typecheck or build — where you reasonably can, and fix what you broke.`;

// AGENTS.md is appended, never a substitute: a project without one used to get a 29-character
// prompt with no tool guidance at all, which is the failure this module exists to fix.
export function buildSystemPrompt(agentsContent: string): string {
  return [SYSTEM_PROMPT, agentsContent].filter(Boolean).join("\n\n");
}
