export type AutoModeOnBlock = "ask" | "deny";

export type ClassifierVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason: string };

export type ToolCallClassifier = (toolName: string, args: unknown) => ClassifierVerdict;

export function parseAutoModeOnBlock(raw: unknown): AutoModeOnBlock {
  return raw === "ask" ? "ask" : "deny";
}

// Production default until a deny-by-default class lands. Tests inject a blocking classifier.
export function classifyToolCall(_toolName: string, _args: unknown): ClassifierVerdict {
  return { kind: "allow" };
}
