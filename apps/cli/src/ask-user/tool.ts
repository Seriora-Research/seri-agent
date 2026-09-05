import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { parseAskPrompt, assertReplyMatchesPrompt } from "./parse";
import {
  ASK_USER_TOOL_NAME,
  MAX_ASK_CHOICES,
  MIN_ASK_CHOICES,
  type AskUserPresenter,
  type AskUserResult,
  type AskUserWire,
} from "./types";

export const askUserSchema = z.object({
  prompt: z.string().min(1),
  choices: z.array(z.string().min(1)).min(MIN_ASK_CHOICES).max(MAX_ASK_CHOICES),
  allowOther: z.boolean().optional(),
});

export function withAskUser(tools: ToolSet, presenter: AskUserPresenter | undefined): ToolSet {
  return {
    ...tools,
    [ASK_USER_TOOL_NAME]: tool({
      description:
        "Ask the user one multiple-choice product or clarification question. " +
        "Pass 2–6 short choices. allowOther (default true) adds a free-text Other. " +
        "Call this only when the worktree cannot answer the question. " +
        "If the result is unavailable, cancelled, or invalid, do not retry — " +
        "state an assumption and continue, or say what is blocked.",
      inputSchema: askUserSchema,
      execute: (input, opts) => executeAskUser(input, presenter, opts.abortSignal),
    }),
  };
}

export async function executeAskUser(
  input: AskUserWire,
  presenter: AskUserPresenter | undefined,
  signal?: AbortSignal,
): Promise<AskUserResult> {
  const parsed = parseAskPrompt(input);
  if (!parsed.ok) return { outcome: "invalid", issues: parsed.issues };
  if (presenter === undefined) return { outcome: "unavailable", reason: "no-human" };
  if (signal?.aborted === true) return { outcome: "cancelled" };
  const raw = await presenter(parsed.prompt, signal);
  if (raw.outcome === "picked" || raw.outcome === "other") {
    return assertReplyMatchesPrompt(parsed.prompt, raw);
  }
  return raw;
}
