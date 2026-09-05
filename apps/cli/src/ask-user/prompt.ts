export const ASK_USER_OVERLAY = `
When a product or clarification choice is underspecified and the files do not
answer it, call \`ask_user\` with one prompt and 2–6 choices. Other (free text)
is on by default; pass allowOther false to hide it. Do not ask a question the
worktree would answer. If the tool returns unavailable, cancelled, or invalid,
do not retry — continue with an explicit assumption, or say what is blocked.
`.trim();
