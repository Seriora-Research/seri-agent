import { CATALOG_PROVIDERS, type ModelProvider } from "@seri/model-catalog";
import { loadConfig, setConfigValues } from "../config/config";
import { DEFAULT_MODEL } from "./groq";

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

// model and provider are resolved as a COUPLED pair, not independently (code-review finding on
// PR #71): SERI_MODEL and SERI_PROVIDER each doing their own env-then-config lookup (the
// resolveModelId()-delegating shape this used to have) meant a one-off env override of ONLY
// SERI_MODEL — `SERI_MODEL=llama-3.3-70b-versatile seri "task"`, the exact workflow README.md
// documents — could pick up a STALE persisted SERI_PROVIDER from config.json (an earlier /model
// pick on e.g. anthropic), producing a model id dispatched to the wrong provider's API. The rule:
// whichever source supplies `model` also supplies `provider` — they are never mixed. An
// unrecognized or missing SERI_PROVIDER value from that SAME source falls back to
// DEFAULT_PROVIDER rather than throwing or reaching into the other source: config.json is
// hand-editable, every other reader in this layer already degrades silently on a malformed value
// (loadConfig drops non-strings, loadVerifyConfig treats anything but "false" as enabled,
// getApiKey's own deliberate `||`), and a startup crash for a typo is a worse failure than a
// documented fallback.
//
// Not delegated to resolveModelId() (groq.ts): that function can't express "which source did
// this come from," only the final resolved string, and this needs to branch on exactly that.
// Reimplemented locally instead — env checked first (SERI_MODEL not set there falls through to
// config), with a SINGLE loadConfig() call for both keys together, so a persisted pair is read
// as what it is: one pair, not two independent lookups. resolveModelId() itself is untouched
// (groq.ts's own DEFAULT_MODEL/env-then-config precedence, and its four existing tests, still
// apply to every OTHER caller); it currently has none in production code, only its own dedicated
// test in groq.test.ts, since this was its last one.
export function resolveDefaultModel(): { model: string; provider: ModelProvider } {
  const envModel = process.env.SERI_MODEL;
  if (envModel) {
    const envProvider = process.env.SERI_PROVIDER;
    return {
      model: envModel,
      provider: envProvider && isModelProvider(envProvider) ? envProvider : DEFAULT_PROVIDER,
    };
  }
  const config = loadConfig();
  const configProvider = config.SERI_PROVIDER;
  return {
    model: config.SERI_MODEL || DEFAULT_MODEL,
    provider: configProvider && isModelProvider(configProvider) ? configProvider : DEFAULT_PROVIDER,
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
