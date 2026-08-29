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

// Human-facing labels — for TUI-facing messages that are purely informational (tuiMissingKeyMessage
// below, cli.ts's rerouteNotice). Never for an instruction that embeds the literal env var name as
// something to type or unset (missingKeyError's own instruction, /setup's own envShadowReason
// "unset it in your shell"): there, PROVIDER_API_KEY_NAMES's raw constant IS the thing the user has
// to act on, and humanizing it would make the instruction un-actionable.
export const PROVIDER_DISPLAY_NAMES: Record<ModelProvider, string> = {
  groq: "Groq",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

// Tagged with the provider (not just a string to parse) so a caller can build a context-specific
// message — tuiMissingKeyMessage, below — without matching on this text.
export type MissingKeyError = Error & { missingKeyProvider: ModelProvider };

// Default missing-key copy for prepareSession and the non-interactive path — reachable before the
// TUI ever mounts (or without one at all), so unlike tuiMissingKeyMessage this can't point at
// /setup, and can't assume a POSIX shell (`export` is not a PowerShell builtin). Tests assert this
// string verbatim.
export function missingKeyError(provider: ModelProvider): MissingKeyError {
  const keyName = PROVIDER_API_KEY_NAMES[provider];
  const error = new Error(
    `${keyName} is not set. Set it as an environment variable and re-run.`,
  ) as MissingKeyError;
  error.missingKeyProvider = provider;
  return error;
}

function isMissingKeyError(err: unknown): err is MissingKeyError {
  return err instanceof Error && "missingKeyProvider" in err;
}

// TUI-only presentation of a turn's caught model-resolution error (cli.ts's runTurn — the one call
// site reachable exclusively from inside an already-running TUI session; prepareSession's own
// earlier resolution, before Ink ever mounts, and the whole non-interactive path still need
// missingKeyError's own message verbatim, so this does not replace it, only the one dispatch that
// can assume a live /setup is a keystroke away). A user already inside the TUI cannot act on "run
// this in your shell" without leaving it — that instruction is for a different audience than the
// one reading this dispatch.
export function tuiMissingKeyMessage(err: unknown): string {
  if (isMissingKeyError(err)) {
    return `No ${PROVIDER_DISPLAY_NAMES[err.missingKeyProvider]} key configured. Run /setup to add one.`;
  }
  return err instanceof Error ? err.message : String(err);
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

// The shared computation `providerKeyState`/`allProviderKeyStates` both reduce to, given a config
// object EITHER has already loaded once — never calling `loadConfig` itself, so a caller with
// several providers to resolve (`allProviderKeyStates`) controls exactly how many reads that
// costs. `process.env[keyName]` wins first, matching `getApiKey`'s own deliberate `||` precedence
// (an env var set to "" reads as unset, not as a valid-looking empty key) — inlined here rather
// than calling `getApiKey`, which would load config.json again itself.
function stateFromConfig(
  provider: ModelProvider,
  config: Record<string, string>,
): ProviderKeyState {
  const keyName = PROVIDER_API_KEY_NAMES[provider];
  const hasConfigEntry = Boolean(config[keyName]);
  const resolved = process.env[keyName] || config[keyName] || undefined;
  if (!resolved) return { provider, keyName, source: "unset", masked: undefined, hasConfigEntry };
  const source = process.env[keyName] ? "env" : "config";
  return { provider, keyName, source, masked: maskValue(resolved), hasConfigEntry };
}

// One provider's key, and where it came from — cli.ts's own onSetupRemove (a single row under the
// cursor). `config` is loaded exactly once here (code-review finding, PR #73, round 2: this used
// to call `loadConfig` directly for `hasConfigEntry` AND call `getApiKey` — which loads it again
// internally — reading config.json twice per call for no reason).
export function providerKeyState(provider: ModelProvider, configDir?: string): ProviderKeyState {
  return stateFromConfig(provider, loadConfig(configDir));
}

// Every provider's key state in one pass — /setup's own full-list read (decideSetupOpen,
// tui/commands.ts). `config` is loaded once for all five providers (code-review finding, PR #73,
// round 3, item #8 — the SAME anti-pattern round 2's own #5 already fixed in `configuredProviders`
// below, but never applied here: `decideSetupOpen` mapped `providerKeyState` over all five
// CATALOG_PROVIDERS, and each call did its own `loadConfig` — five redundant reads to open /setup,
// or to refresh it after any add/remove).
export function allProviderKeyStates(configDir?: string): ProviderKeyState[] {
  const config = loadConfig(configDir);
  return CATALOG_PROVIDERS.map((provider) => stateFromConfig(provider, config));
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
