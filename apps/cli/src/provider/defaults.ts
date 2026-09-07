import { CATALOG_PROVIDERS, type ModelProvider } from "@seri/model-catalog";
import { loadConfig, setConfigValues } from "../config/config";
import { DEFAULT_MODEL } from "./groq";

export const DEFAULT_PROVIDER: ModelProvider = "groq";

export function isModelProvider(value: string): value is ModelProvider {
  return CATALOG_PROVIDERS.includes(value as ModelProvider);
}

export function resolveDefaultModel(configDir?: string): {
  model: string;
  provider: ModelProvider | undefined;
} {
  const envModel = process.env.SERI_MODEL;
  if (envModel) {
    const envProvider = process.env.SERI_PROVIDER;
    return {
      model: envModel,
      provider: envProvider && isModelProvider(envProvider) ? envProvider : undefined,
    };
  }
  const config = loadConfig(configDir);
  const configProvider = config.SERI_PROVIDER;
  return {
    model: config.SERI_MODEL || DEFAULT_MODEL,
    provider: configProvider && isModelProvider(configProvider) ? configProvider : undefined,
  };
}

export function persistDefaultModel(
  pick: { model: string; provider: ModelProvider },
  configDir?: string,
): void {
  setConfigValues({ SERI_MODEL: pick.model, SERI_PROVIDER: pick.provider }, configDir);
}
