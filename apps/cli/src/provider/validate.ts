import { generateText as generateTextReal } from "ai";
import type { ModelProvider } from "@seri/model-catalog";
import { messageOf } from "../errors";
import { getAnthropicModel } from "./anthropic";
import { getGoogleModel } from "./google";
import { getGroqModel } from "./groq";
import { getOpenAIModel } from "./openai";
import { getOpenRouterModel } from "./openrouter";

// D5 (feature-plan.md): the cheapest model per provider, verified present in the bundled manifest
// and aligned with nativeProviders.live.test.ts's own choices where they overlap (anthropic,
// openai, google) — that file's own opt-in `validateProviderKey` round-trips (extending its
// existing get<X>Model round-trips, all skip-by-default behind SERI_LIVE_PROVIDER_CHECK=1) reuse
// these same ids for groq/openrouter too, rather than inventing a second probe-model convention.
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
  // An empty/falsy key can never authenticate — reject it here, the same way a real 401/403
  // would, rather than falling into the switch below. Bug fixed here (reviewer-verifier,
  // multi-provider-byok-phase-2): every get<X>Model constructor (apps/cli/src/provider/*.ts) has
  // its own `if (!apiKey) throw missingKeyError(...)` guard, which used to fire SYNCHRONOUSLY from
  // inside the switch below — outside this function's own try/catch, so an empty-string submit
  // made this function reject instead of resolve, contradicting the "never throws" contract
  // cli.ts's onSetupKeyEntered relies on (no try/catch around its own `await
  // validateProviderKey(...)` call) and leaving /setup's panel stuck on "Validating…" forever.
  //
  // Ahead of the SERI_SKIP_KEY_VALIDATION check below, not after (round-2 reviewer-verifier
  // finding): the escape hatch is for skipping the NETWORK probe in tests, not for waiving "was
  // anything even typed" — with the empty check below it, SERI_SKIP_KEY_VALIDATION=1 returned
  // `{ok: true}` for an empty key, and onSetupKeyEntered (cli.ts) has nothing else guarding
  // against storing that empty string into config.json (setConfigValue does not reject empties,
  // and /setup is the TUI writer of BYOK keys).
  if (!apiKey) {
    return { ok: false, reason: "auth", message: "API key cannot be empty." };
  }

  // The escape hatch every pty test uses — checked before anything else touches the network.
  if (process.env.SERI_SKIP_KEY_VALIDATION === "1") {
    return { ok: true, checked: false };
  }

  const modelId = VALIDATION_MODEL_IDS[provider];
  const generate = deps.generate ?? generateTextReal;
  try {
    // A five-case switch, mirroring getModel's own dispatch (provider/model.ts) — including that
    // function's own reasoning for a switch over a ternary/lookup table: an unrecognized value is
    // unreachable through the real ModelProvider union (this function's own caller reads a value
    // the panel itself already constrained to CATALOG_PROVIDERS), but unlike getModel's own switch
    // this function's documented contract is "never throws" (its own callers, cli.ts's
    // onSetupKeyEntered included, rely on that) — so the default case returns an ok:false result
    // naming the bad value instead of throwing, dead code today but consistent with the contract
    // rather than a second, silent way to break it later.
    //
    // Inside this try, not above it (code-review finding, PR #73, round 2, item #3): each
    // get<X>Model constructor has its own `if (!apiKey) throw missingKeyError(...)` guard, and the
    // empty-key check above this function already closes THAT one known synchronous-throw path —
    // but if any constructor ever throws for a DIFFERENT reason (a future SDK version validating
    // key format up front, say), this is what keeps the "never throws" contract intact regardless,
    // rather than only for the one failure mode anticipated today.
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
