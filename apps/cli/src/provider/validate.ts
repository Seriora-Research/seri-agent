import { generateText as generateTextReal } from "ai";
import type { ModelProvider } from "@seri/model-catalog";
import { getAnthropicModel } from "./anthropic";
import { getGoogleModel } from "./google";
import { getGroqModel } from "./groq";
import { getOpenAIModel } from "./openai";
import { getOpenRouterModel } from "./openrouter";

// D5 (feature-plan.md): the cheapest model per provider, verified present in the bundled manifest
// and aligned with nativeProviders.live.test.ts's own choices where they overlap (anthropic,
// openai, google) — this file's own live round-trip test extends that same shape to groq/
// openrouter rather than inventing a second probe-model convention.
export const VALIDATION_MODEL_IDS: Record<ModelProvider, string> = {
  groq: "openai/gpt-oss-20b",
  openrouter: "openai/gpt-oss-20b",
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
  google: "gemini-2.5-flash",
};

// Not a real session — this call never touches loop.ts's own turn machinery, so there is no
// session id to reuse. A fixed, recognizable placeholder rather than a random one: identical on
// every call, which is what a future OpenRouter dashboard reading session_id would want to see
// grouped together as "the validation probe," not one-off noise.
const VALIDATION_SESSION_ID = "seri-setup-key-validation";

export type ValidateKeyDeps = {
  // Injected so no test ever calls the real AI SDK — SERI_SKIP_KEY_VALIDATION is the OTHER escape
  // hatch (below), for callers that want to skip the probe outright rather than fake its result.
  generate?: typeof generateTextReal;
};

export type ValidateKeyResult =
  | { ok: true; checked: boolean; warning?: string }
  | { ok: false; reason: "auth"; message: string };

// AI SDK errors surface as `APICallError`, which carries `statusCode` — read structurally (duck
// typed) rather than importing the class, since every provider funnels through the same shape and
// this file has no other reason to depend on the SDK's own error hierarchy.
function isAuthFailure(err: unknown): boolean {
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  return statusCode === 401 || statusCode === 403;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// D5's own mechanism: one minimal `generateText` call against the candidate key (never the
// caller's already-stored one — `apiKey` is always the value /setup's panel just typed, not yet
// persisted), `maxOutputTokens: 1` and `maxRetries: 0` to keep cost and latency negligible, a 10s
// timeout matching catalog.ts's own FETCH_TIMEOUT_MS precedent. Classification: ONLY 401/403
// rejects the key outright; everything else (network blip, timeout, 429, an unfamiliar probe
// model id, a non-Error throw) stores the key anyway with a warning — refusing to store on a
// transient failure would make /setup unusable offline or behind a restrictive proxy, and an
// unverifiable-but-wrong key still fails loudly on first real use, which is today's baseline
// (no validation at all), so this can only be an improvement, never a regression.
export async function validateProviderKey(
  provider: ModelProvider,
  apiKey: string,
  deps: ValidateKeyDeps = {},
): Promise<ValidateKeyResult> {
  // The escape hatch every pty test uses — checked before anything else touches the network.
  if (process.env.SERI_SKIP_KEY_VALIDATION === "1") {
    return { ok: true, checked: false };
  }

  const modelId = VALIDATION_MODEL_IDS[provider];
  // A five-case switch, mirroring getModel's own dispatch (provider/model.ts) — including that
  // function's own reasoning for a switch over a ternary/lookup table: an unrecognized value
  // (unreachable through the real ModelProvider union, but this function's own caller reads a
  // value the panel itself already constrained to CATALOG_PROVIDERS, so this is belt-and-braces)
  // throws naming the bad value rather than silently doing nothing.
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
    default:
      throw new Error(`Unknown model provider: ${JSON.stringify(provider)}`);
  }

  const generate = deps.generate ?? generateTextReal;
  try {
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
