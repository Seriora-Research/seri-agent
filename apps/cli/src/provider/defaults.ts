import { CATALOG_PROVIDERS, type ModelProvider } from "@seri/model-catalog";
import { getApiKey, setConfigValues } from "../config/config";
import { resolveModelId } from "./groq";

// Not in groq.ts: that file's DEFAULT_MODEL carries a groq-model-specific measurement comment
// (20/20 vs 5/11 tool calls), and a provider-agnostic resolver sitting under that comment would
// read as groq-scoped and drift.
export const DEFAULT_PROVIDER: ModelProvider = "groq";

// Derived from CATALOG_PROVIDERS (model-catalog's own single source of truth for which providers
// are real) rather than a second, independently-hardcoded literal list: a future 6th provider
// added to CATALOG_PROVIDERS/ModelProvider/model.ts's switch but forgotten here used to silently
// fall back to DEFAULT_PROVIDER instead of being recognized — this closes that one gap, though
// ModelProvider's own union and model.ts's switch cases remain separate, unavoidable sources of
// truth without a bigger refactor.
export function isModelProvider(value: string): value is ModelProvider {
  return CATALOG_PROVIDERS.includes(value as ModelProvider);
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

// One setConfigValues call, not two setConfigValue calls: SERI_MODEL and SERI_PROVIDER are a
// pair — a process kill, or a write failure, between two independent writes would leave
// config.json with the new model but the old provider (or vice versa), the same mismatch class
// cli.ts's own legacy-resume backfill guards against on the read side. setConfigValues's own
// comment has the mechanism (one loadConfig/writeConfig pair for both keys).
export function persistDefaultModel(pick: { model: string; provider: ModelProvider }): void {
  setConfigValues({ SERI_MODEL: pick.model, SERI_PROVIDER: pick.provider });
}
