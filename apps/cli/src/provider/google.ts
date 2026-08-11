import { createGoogle } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

// No default for modelId, matching groq.ts: the caller (provider/model.ts) is the single
// authority on what id to construct with.
//
// `GOOGLE_GENERATIVE_AI_API_KEY`, not a shorter `GOOGLE_API_KEY`: matches the installed
// @ai-sdk/google@4.0.39's own implicit env-var default, so a user who already exports it for
// some other tool works here too — read explicitly via getApiKey regardless, same as every other
// provider in this directory, never relying on the SDK's own fallback.
//
// `createGoogle`, not `createGoogleGenerativeAI`: confirmed against the installed package's own
// dist/index.d.ts — `createGoogleGenerativeAI` is exported only as `createGoogle as
// createGoogleGenerativeAI`, i.e. a re-export alias of the same function under its old name.
// `createGoogle` is the canonical one at this version.
//
// `apiKey` defaults to today's lookup but can be overridden — see anthropic.ts's own comment on
// why (validate.ts's probe call, D5).
export function getGoogleModel(
  modelId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.google),
): LanguageModel {
  if (!apiKey) throw missingKeyError("google");
  return createGoogle({ apiKey })(modelId);
}
