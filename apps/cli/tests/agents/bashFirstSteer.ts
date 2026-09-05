import { expect } from "bun:test";

// Verbatim attachment Claude Code injects in bypass/auto (anthropics/claude-code#92271).
export const CLAUDE_CODE_BASH_FIRST_ATTACHMENT = `While bypass permissions mode is active:

Do your work through the Bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated Read, Edit, or Write tools. Fall back to a dedicated tool only when Bash genuinely cannot do the job.`;

const BASH_FIRST_PHRASES = [
  "Do your work through the Bash tool",
  "rather than using the dedicated",
  "While bypass permissions mode is active",
] as const;

export function bashFirstSteerIn(text: string): string | undefined {
  const folded = text.toLowerCase();
  return BASH_FIRST_PHRASES.find((phrase) => folded.includes(phrase.toLowerCase()));
}

export function expectNoBashFirstSteer(text: string): void {
  expect(bashFirstSteerIn(text)).toBeUndefined();
}

export function expectDedicatedFileTools(text: string): void {
  expect(text).toMatch(/prefer[\s\S]{0,80}dedicated tools[\s\S]{0,80}shell/i);
  expect(text).toMatch(/`read_file`[\s\S]{0,40}instead of[\s\S]{0,20}`cat`/i);
  expect(text).toMatch(/`edit`[\s\S]{0,40}`write_file`[\s\S]{0,40}instead of[\s\S]{0,20}`sed`/i);
}
