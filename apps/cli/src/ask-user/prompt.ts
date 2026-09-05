export const ASK_USER_OVERLAY = `
When a product or clarification choice is underspecified and the files do not
answer it, call \`ask_user\` with one prompt and 2–6 choices. Set allowOther
when a listed choice might not fit. Do not ask a question the worktree would
answer. If the tool returns unavailable, do not retry — continue with an
explicit assumption. If it returns cancelled, stop asking and proceed with
what you have or say what is blocked.
`.trim();
