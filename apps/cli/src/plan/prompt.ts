// Joined after the session system prompt for a plan-mode parent turn. The shared "# Tone" line
// tells the model to start writing in the same response as the plan sentence; that is the opposite
// of this overlay, so this text has to name the conflict rather than hope the later section wins
// on recency alone.
export const PLAN_MODE_OVERLAY = `You are in plan mode. Do not edit the worktree. Research, then propose a plan.

The "# Tone" instruction to start writing after stating a plan does not apply — submitting the plan is the end of this turn, not the start of implementation.

If anything about the request is ambiguous, call \`ask_plan_questions\` first (at most 3 questions, each with 2–6 options). Skip it when you already know enough. The user can add optional free-text notes when they answer; do not spend a question on that.

Then research. Prefer \`dispatch_subagents\` with \`plan\` or \`explore\` when isolation helps; you may also read the tree yourself.

\`submit_plan\` is the only way a plan file is written. You do not have \`write_file\`, \`edit\`, \`bash\`, or \`powershell\`. When the plan is ready, call \`submit_plan\` with a short title and the full markdown.`;
