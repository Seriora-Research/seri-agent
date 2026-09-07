import { CATALOG_PROVIDERS, type ModelProvider } from "@seri/model-catalog";
import { maskValue } from "../config/commands";
import { loadConfig } from "../config/config";

export const PROVIDER_API_KEY_NAMES: Record<ModelProvider, string> = {
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",

  // GOOGLE_GENERATIVE_AI_API_KEY matches @ai-sdk/google's implicit env-var default.
  google: "GOOGLE_GENERATIVE_AI_API_KEY",

  // XAI_API_KEY is xAI's console key; SuperGrok is a second credential on the route.
  xai: "XAI_API_KEY",
};

export const PROVIDER_DISPLAY_NAMES: Record<ModelProvider, string> = {
  groq: "Groq",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
};

export type MissingKeyError = Error & { missingKeyProvider: ModelProvider };

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

  hasConfigEntry: boolean;
};

function stateFromConfig(
  provider: ModelProvider,
  config: Record<string, string>,
): ProviderKeyState {
  const keyName = PROVIDER_API_KEY_NAMES[provider];
  const hasConfigEntry = Boolean(config[keyName]);
  // process.env[key] || treats "" as unset.
  const resolved = process.env[keyName] || config[keyName] || undefined;
  if (!resolved) return { provider, keyName, source: "unset", masked: undefined, hasConfigEntry };
  const source = process.env[keyName] ? "env" : "config";
  return { provider, keyName, source, masked: maskValue(resolved), hasConfigEntry };
}

export function providerKeyState(provider: ModelProvider, configDir?: string): ProviderKeyState {
  return stateFromConfig(provider, loadConfig(configDir));
}

export function allProviderKeyStates(configDir?: string): ProviderKeyState[] {
  const config = loadConfig(configDir);
  return CATALOG_PROVIDERS.map((provider) => stateFromConfig(provider, config));
}

export function configuredProviders(configDir?: string): ReadonlySet<ModelProvider> {
  const config = loadConfig(configDir);
  const configured = new Set<ModelProvider>();
  for (const provider of CATALOG_PROVIDERS) {
    const keyName = PROVIDER_API_KEY_NAMES[provider];
    if (process.env[keyName] || config[keyName]) configured.add(provider);
  }
  return configured;
}
