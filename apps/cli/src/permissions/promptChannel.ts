export type PromptChannel = "live" | "none";

export function parsePromptChannel(raw: string | undefined): PromptChannel | { error: string } {
  if (raw === undefined || raw === "live") return "live";
  if (raw === "none") return "none";
  return { error: `Invalid --permission-prompts value: ${raw}` };
}
