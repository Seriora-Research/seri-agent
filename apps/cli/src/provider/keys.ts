import { CATALOG_PROVIDERS, type ModelProvider } from "@seri/model-catalog";
import { maskValue } from "../config/commands";
import { loadConfig } from "../config/config";

// The single source of truth for "which env var/config key does this provider read" — replaces
// the same literal hand-duplicated across anthropic.ts/openai.ts/google.ts/groq.ts/openrouter.ts.
// `Record<ModelProvider, string>`, not a derived-at-runtime map: a sixth ModelProvider union
// member with no entry here is a COMPILE error (missing property), which is a stronger guarantee
// than provider/defaults.ts's own `isModelProvider` — that one derives membership from
// CATALOG_PROVIDERS at runtime because it has no per-provider payload to type-check against; this
// one does, so the type system can enforce it instead of a test having to.
export const PROVIDER_API_KEY_NAMES: Record<ModelProvider, string> = {
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  // Not the shorter GOOGLE_API_KEY: matches @ai-sdk/google's own implicit env-var default (see
  // google.ts's own comment, unchanged by this refactor).
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

// The exact legacy message every provider file threw inline before this refactor — byte-for-byte,
// since cli.test.ts and each provider's own test assert it verbatim.
export function missingKeyError(provider: ModelProvider): Error {
  const keyName = PROVIDER_API_KEY_NAMES[provider];
  return new Error(`${keyName} is not set. Run: seri config set ${keyName} <your-key>`);
}

export type ProviderKeyState = {
  provider: ModelProvider;
  keyName: string;
  source: "env" | "config" | "unset";
  masked: string | undefined;
  // Independent of `source` — bug fixed here (code-review, PR #73): an env var can SHADOW a
  // config.json entry that still exists underneath it. `source` reports which one actually wins
  // for display/masking (env, matching getApiKey's own precedence); this reports whether
  // config.json has something to remove, regardless of which source won — /setup's own
  // `removable` needs THIS, not `source === "config"`, or a previously-saved secret becomes
  // permanently unremovable the moment the same-named env var is exported.
  hasConfigEntry: boolean;
};

// One provider's key, and where it came from — /setup's own per-row read (decideSetupOpen,
// tui/commands.ts). `config` is loaded exactly once here (code-review finding, PR #73, round 2:
// this used to call `loadConfig` directly for `hasConfigEntry` AND call `getApiKey` — which loads
// it again internally — reading config.json twice per call for no reason). `process.env[keyName]`
// still wins first, matching `getApiKey`'s own deliberate `||` precedence (an env var set to ""
// reads as unset, not as a valid-looking empty key) — that precedence is inlined here rather than
// calling `getApiKey` a second time, the one place in this function it would cost an extra read.
export function providerKeyState(provider: ModelProvider, configDir?: string): ProviderKeyState {
  const keyName = PROVIDER_API_KEY_NAMES[provider];
  const config = loadConfig(configDir);
  const hasConfigEntry = Boolean(config[keyName]);
  const resolved = process.env[keyName] || config[keyName] || undefined;
  if (!resolved) return { provider, keyName, source: "unset", masked: undefined, hasConfigEntry };
  const source = process.env[keyName] ? "env" : "config";
  return { provider, keyName, source, masked: maskValue(resolved), hasConfigEntry };
}

// The providers routing.ts's resolveRoute is allowed to reroute onto — every CATALOG_PROVIDERS
// member whose key resolves truthy via env or config.json, same precedence as every other reader
// in this layer. `config` is loaded once for all five providers (code-review finding, PR #73,
// round 2 — this used to call `getApiKey`, and therefore `loadConfig`, once PER provider: five
// redundant synchronous reads of the same file on every call, and `resolveRoute` calls this on
// EVERY turn per cli.ts's own comment on that call site).
export function configuredProviders(configDir?: string): ReadonlySet<ModelProvider> {
  const config = loadConfig(configDir);
  const configured = new Set<ModelProvider>();
  for (const provider of CATALOG_PROVIDERS) {
    const keyName = PROVIDER_API_KEY_NAMES[provider];
    if (process.env[keyName] || config[keyName]) configured.add(provider);
  }
  return configured;
}
