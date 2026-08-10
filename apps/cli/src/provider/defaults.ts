import type { ModelProvider } from "@seri/model-catalog";
import { getApiKey, setConfigValue } from "../config/config";
import { resolveModelId } from "./groq";

// Not in groq.ts: that file's DEFAULT_MODEL carries a groq-model-specific measurement comment
// (20/20 vs 5/11 tool calls), and a provider-agnostic resolver sitting under that comment would
// read as groq-scoped and drift.
export const DEFAULT_PROVIDER: ModelProvider = "groq";

export function isModelProvider(value: string): value is ModelProvider {
  return (
    value === "groq" ||
    value === "openrouter" ||
    value === "anthropic" ||
    value === "openai" ||
    value === "google"
  );
}

// The model half delegates to resolveModelId() (groq.ts) — zero duplication, and SERI_MODEL's
// existing env-then-config precedence and its own tests keep working unchanged. The provider half
// mirrors it: `SERI_PROVIDER`, env-then-config via getApiKey, falling back to DEFAULT_PROVIDER.
//
// An unrecognized SERI_PROVIDER value (including "") falls back silently rather than throwing:
// config.json is hand-editable, every other reader in this layer already degrades silently on a
// malformed value (loadConfig drops non-strings, loadVerifyConfig treats anything but "false" as
// enabled, getApiKey's own deliberate `||`), and a startup crash for a typo is a worse failure
// than a documented fallback.
export function resolveDefaultModel(): { model: string; provider: ModelProvider } {
  const provider = getApiKey("SERI_PROVIDER");
  return {
    model: resolveModelId(),
    provider: provider !== undefined && isModelProvider(provider) ? provider : DEFAULT_PROVIDER,
  };
}

export function persistDefaultModel(pick: { model: string; provider: ModelProvider }): void {
  setConfigValue("SERI_MODEL", pick.model);
  setConfigValue("SERI_PROVIDER", pick.provider);
}
