export const ASK_USER_TOOL_NAME = "ask_user";

export const MIN_ASK_CHOICES = 2;
export const MAX_ASK_CHOICES = 6;

export type AskPrompt = {
  readonly prompt: string;
  readonly choices: readonly string[];
  readonly allowOther: boolean;
};

export type HumanReply =
  | { readonly outcome: "picked"; readonly choice: string }
  | { readonly outcome: "other"; readonly text: string }
  | { readonly outcome: "cancelled" };

export type UnavailableReason = "no-human" | "nested-approval";

export type AskUserResult =
  | HumanReply
  | { readonly outcome: "unavailable"; readonly reason: UnavailableReason }
  | { readonly outcome: "invalid"; readonly issues: readonly string[] };

export type AskUserPresenter = (
  prompt: AskPrompt,
  signal?: AbortSignal,
) => Promise<AskUserResult>;

export type AskUserWire = {
  prompt: string;
  choices: string[];
  allowOther?: boolean;
};
