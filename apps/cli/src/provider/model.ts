import type { ModelProvider } from "@seri/model-catalog";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { getAnthropicModel as getAnthropicModelReal } from "./anthropic";
import { getCodexSubscriptionModel as getCodexSubscriptionModelReal } from "./codex";
import { getGatewayModel as getGatewayModelReal } from "./gateway";
import { getGoogleModel as getGoogleModelReal } from "./google";
import { getGroqModel as getGroqModelReal } from "./groq";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";
import { getOpenAIModel as getOpenAIModelReal } from "./openai";
import { getOpenRouterModel as getOpenRouterModelReal } from "./openrouter";
import type { ResolvedRoute } from "./routing";
import {
  getXaiModel as getXaiModelReal,
  getXaiSubscriptionModel as getXaiSubscriptionModelReal,
} from "./xai";

type ModelDeps = {
  getGroqModel?: typeof getGroqModelReal;
  getOpenRouterModel?: typeof getOpenRouterModelReal;
  getAnthropicModel?: typeof getAnthropicModelReal;
  getOpenAIModel?: typeof getOpenAIModelReal;
  getGoogleModel?: typeof getGoogleModelReal;
  getXaiModel?: typeof getXaiModelReal;
};

export function getModel(
  id: string,
  provider: ModelProvider,
  sessionId: string,
  deps: ModelDeps = {},
  configDir?: string,
): LanguageModel {
  const getGroqModelFn = deps.getGroqModel ?? getGroqModelReal;
  const getOpenRouterModelFn = deps.getOpenRouterModel ?? getOpenRouterModelReal;
  const getAnthropicModelFn = deps.getAnthropicModel ?? getAnthropicModelReal;
  const getOpenAIModelFn = deps.getOpenAIModel ?? getOpenAIModelReal;
  const getGoogleModelFn = deps.getGoogleModel ?? getGoogleModelReal;
  const getXaiModelFn = deps.getXaiModel ?? getXaiModelReal;
  switch (provider) {
    case "groq": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.groq, configDir);
      if (getGroqModelFn === getGroqModelReal && apiKey === undefined) {
        throw missingKeyError("groq");
      }
      return getGroqModelFn(id, apiKey);
    }
    case "openrouter": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.openrouter, configDir);
      if (getOpenRouterModelFn === getOpenRouterModelReal && apiKey === undefined) {
        throw missingKeyError("openrouter");
      }
      return getOpenRouterModelFn(id, sessionId, apiKey, configDir);
    }
    case "anthropic": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.anthropic, configDir);
      if (getAnthropicModelFn === getAnthropicModelReal && apiKey === undefined) {
        throw missingKeyError("anthropic");
      }
      return getAnthropicModelFn(id, apiKey);
    }
    case "openai": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.openai, configDir);
      if (getOpenAIModelFn === getOpenAIModelReal && apiKey === undefined) {
        throw missingKeyError("openai");
      }
      return getOpenAIModelFn(id, apiKey);
    }
    case "google": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.google, configDir);
      if (getGoogleModelFn === getGoogleModelReal && apiKey === undefined) {
        throw missingKeyError("google");
      }
      return getGoogleModelFn(id, apiKey);
    }
    case "xai": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.xai, configDir);
      if (getXaiModelFn === getXaiModelReal && apiKey === undefined) {
        throw missingKeyError("xai");
      }
      return getXaiModelFn(id, apiKey, configDir);
    }
    default:
      throw new Error(`Unknown model provider: ${JSON.stringify(provider)}`);
  }
}

type DispatchModelDeps = ModelDeps & {
  getGatewayModel?: typeof getGatewayModelReal;
  getXaiSubscriptionModel?: typeof getXaiSubscriptionModelReal;
  getCodexSubscriptionModel?: typeof getCodexSubscriptionModelReal;
};

export function dispatchModel(
  route: ResolvedRoute,
  sessionId: string,
  configDir: string,
  deps: DispatchModelDeps,
): LanguageModel {
  if (route.credential === "gateway") {
    const getGatewayModelFn = deps.getGatewayModel ?? getGatewayModelReal;
    return getGatewayModelFn(route.model, route.provider, sessionId, configDir);
  }
  if (route.credential === "subscription") {
    if (route.provider === "xai") {
      const getXaiSubscriptionModelFn = deps.getXaiSubscriptionModel ?? getXaiSubscriptionModelReal;
      return getXaiSubscriptionModelFn(route.model, configDir, sessionId);
    }
    if (route.provider === "openai") {
      const getCodexSubscriptionModelFn =
        deps.getCodexSubscriptionModel ?? getCodexSubscriptionModelReal;
      return getCodexSubscriptionModelFn(route.model, configDir, sessionId);
    }
    throw new Error(`No subscription client for provider: ${JSON.stringify(route.provider)}`);
  }
  return getModel(route.model, route.provider, sessionId, deps, configDir);
}
