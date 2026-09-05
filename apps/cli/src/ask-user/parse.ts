import {
  MAX_ASK_CHOICES,
  MIN_ASK_CHOICES,
  type AskPrompt,
  type AskUserWire,
  type HumanReply,
} from "./types";

export type ParseAskPromptResult =
  | { readonly ok: true; readonly prompt: AskPrompt }
  | { readonly ok: false; readonly issues: readonly string[] };

export function parseAskPrompt(input: AskUserWire): ParseAskPromptResult {
  const issues: string[] = [];
  const prompt = input.prompt.trim();
  if (prompt.length === 0) issues.push("prompt is empty");

  const choices: string[] = [];
  for (const raw of input.choices) {
    const label = raw.trim();
    if (label.length > 0) choices.push(label);
  }
  if (choices.length < MIN_ASK_CHOICES || choices.length > MAX_ASK_CHOICES) {
    issues.push("choices must have 2–6 non-empty labels");
  }
  if (new Set(choices).size !== choices.length) issues.push("choices must be unique");

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    prompt: {
      prompt,
      choices,
      allowOther: input.allowOther ?? true,
    },
  };
}

export function assertReplyMatchesPrompt(
  prompt: AskPrompt,
  reply: HumanReply,
): HumanReply | { readonly outcome: "invalid"; readonly issues: readonly string[] } {
  if (reply.outcome === "cancelled") return reply;
  if (reply.outcome === "picked") {
    if (!prompt.choices.includes(reply.choice)) {
      return { outcome: "invalid", issues: ["picked choice is not in the list"] };
    }
    return reply;
  }
  if (!prompt.allowOther) return { outcome: "invalid", issues: ["other is not allowed"] };
  const text = reply.text.trim();
  if (text.length === 0) return { outcome: "invalid", issues: ["other text is empty"] };
  return { outcome: "other", text };
}
