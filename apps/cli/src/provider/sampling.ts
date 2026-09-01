import type { ModelProvider } from "@seri/model-catalog";
import { configValue, loadConfig } from "../config/config";
import { getConfigDir } from "../config/paths";
import type { RouteCredential } from "./routing";

export const TEMPERATURE_CONFIG_KEY = "SERI_TEMPERATURE";
export const SEED_CONFIG_KEY = "SERI_SEED";
export const OPENROUTER_PROVIDER_CONFIG_KEY = "SERI_OPENROUTER_PROVIDER";

export type SamplingSupport = "supported" | "unsupported";

export type SamplingRecord = number | null | "unsupported";

export type ResolvedSampling = {
  temperature: number | undefined;
  seed: number | undefined;
  temperatureRecord: SamplingRecord;
  seedRecord: SamplingRecord;
};

// Codex (`openai` + subscription) answers `Unsupported parameter: temperature`
// (and the same for seed). OpenAI Responses — the key-path surface — has no
// `seed` field. Anthropic has never had one. The Grok CLI proxy is
// Responses-shaped and unconfirmed; both subscription paths therefore omit
// both knobs rather than risk a 400 on a paid turn.
export function temperatureSupport(
  provider: ModelProvider | undefined,
  credential: RouteCredential | undefined,
): SamplingSupport {
  if (provider === undefined) return "unsupported";
  if (credential === "subscription") return "unsupported";
  return "supported";
}

export function seedSupport(
  provider: ModelProvider | undefined,
  credential: RouteCredential | undefined,
): SamplingSupport {
  if (provider === undefined) return "unsupported";
  if (credential === "subscription") return "unsupported";
  if (provider === "anthropic") return "unsupported";
  // The OpenAI key path is Responses, which has no seed. The gateway is
  // Chat Completions (`.chat()`), which does.
  if (provider === "openai" && credential !== "gateway") return "unsupported";
  return "supported";
}

export function parseTemperature(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export function parseSeed(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return parsed;
}

export function parseOpenRouterPin(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const order = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return order.length > 0 ? order : undefined;
}

export function loadSamplingConfig(configDir?: string): {
  temperature: number | undefined;
  seed: number | undefined;
  openRouterPin: string[] | undefined;
} {
  const config = loadConfig(configDir ?? getConfigDir());
  return {
    temperature: parseTemperature(configValue(TEMPERATURE_CONFIG_KEY, config)),
    seed: parseSeed(configValue(SEED_CONFIG_KEY, config)),
    openRouterPin: parseOpenRouterPin(configValue(OPENROUTER_PROVIDER_CONFIG_KEY, config)),
  };
}

export function loadOpenRouterPin(configDir?: string): string[] | undefined {
  return loadSamplingConfig(configDir).openRouterPin;
}

export function resolveSampling(
  provider: ModelProvider | undefined,
  credential: RouteCredential | undefined,
  configured: { temperature?: number; seed?: number } = loadSamplingConfig(),
): ResolvedSampling {
  const temperatureOk = temperatureSupport(provider, credential) === "supported";
  const seedOk = seedSupport(provider, credential) === "supported";
  return {
    temperature: temperatureOk ? configured.temperature : undefined,
    seed: seedOk ? configured.seed : undefined,
    temperatureRecord: temperatureOk ? (configured.temperature ?? null) : "unsupported",
    seedRecord: seedOk ? (configured.seed ?? null) : "unsupported",
  };
}

export function samplingCallFields(sampling: ResolvedSampling): {
  temperature?: number;
  seed?: number;
} {
  return {
    ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
    ...(sampling.seed !== undefined ? { seed: sampling.seed } : {}),
  };
}
