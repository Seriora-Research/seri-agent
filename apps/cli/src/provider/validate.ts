import type { ModelProvider } from "@seri/model-catalog";
import { generateText as generateTextReal } from "ai";
import { messageOf } from "../errors";
import { getAnthropicModel } from "./anthropic";
import { getGoogleModel } from "./google";
import { getGroqModel } from "./groq";
import { getOpenAIModel } from "./openai";
import { getOpenRouterModel } from "./openrouter";
import { getXaiModel } from "./xai";

export const VALIDATION_MODEL_IDS: Record<ModelProvider, string> = {
  groq: "openai/gpt-oss-20b",
  openrouter: "openai/gpt-oss-20b",
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
  google: "gemini-2.5-flash",

  xai: "grok-4.3",
};

const VALIDATION_SESSION_ID = "seri-setup-key-validation";

export type ValidateKeyDeps = {
  generate?: typeof generateTextReal;
};

export type ValidateKeyResult =
  | { ok: true; checked: boolean; warning?: string }
  | { ok: false; reason: "auth"; message: string };

// AI SDK errors surface as APICallError with statusCode; read structurally.
function isAuthFailure(err: unknown): boolean {
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  return statusCode === 401 || statusCode === 403;
}

export async function validateProviderKey(
  provider: ModelProvider,
  apiKey: string,
  deps: ValidateKeyDeps = {},
): Promise<ValidateKeyResult> {
  if (!apiKey) {
    return { ok: false, reason: "auth", message: "API key cannot be empty." };
  }

  if (process.env.SERI_SKIP_KEY_VALIDATION === "1") {
    return { ok: true, checked: false };
  }

  const modelId = VALIDATION_MODEL_IDS[provider];
  const generate = deps.generate ?? generateTextReal;
  try {
    let model: ReturnType<typeof getGroqModel>;
    switch (provider) {
      case "groq":
        model = getGroqModel(modelId, apiKey);
        break;
      case "openrouter":
        model = getOpenRouterModel(modelId, VALIDATION_SESSION_ID, apiKey);
        break;
      case "anthropic":
        model = getAnthropicModel(modelId, apiKey);
        break;
      case "openai":
        model = getOpenAIModel(modelId, apiKey);
        break;
      case "google":
        model = getGoogleModel(modelId, apiKey);
        break;
      case "xai":
        model = getXaiModel(modelId, apiKey);
        break;
      default:
        return {
          ok: false,
          reason: "auth",
          message: `Unknown model provider: ${JSON.stringify(provider)}`,
        };
    }
    await generate({
      model,
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 1,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(10_000),
    });
    return { ok: true, checked: true };
  } catch (err) {
    if (isAuthFailure(err)) {
      return { ok: false, reason: "auth", message: messageOf(err) };
    }
    return { ok: true, checked: false, warning: messageOf(err) };
  }
}
