import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import { createOpenAI } from "@ai-sdk/openai";
import { type LanguageModel, wrapLanguageModel } from "ai";
import pkg from "../../package.json";
import { loadUsableCodexGrant } from "../auth/codexAuthStore";
import { CODEX_BASE_URL_DEFAULT, CODEX_ORIGINATOR } from "../auth/codexOAuth";
import { type CodexRefreshResult, refreshCodexSubscription } from "../auth/codexRefresh";
import { getApiKey } from "../config/config";

export { CODEX_BASE_URL_DEFAULT };
export const CODEX_ORIGINATOR_DEFAULT = CODEX_ORIGINATOR;

export function codexBaseUrl(configDir?: string): string {
  return getApiKey("SERI_CODEX_BASE_URL", configDir) ?? CODEX_BASE_URL_DEFAULT;
}

export function codexOriginator(configDir?: string): string {
  return getApiKey("SERI_CODEX_ORIGINATOR", configDir) ?? CODEX_ORIGINATOR_DEFAULT;
}

export function seriUserAgent(): string {
  return `seri/${pkg.version} (${platform()}; ${arch()})`;
}

const UNUSED_PLACEHOLDER_KEY = "unused-subscription-placeholder";

function asHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers));
}

export function codexAuthedFetch(
  configDir: string,
  sessionId: string,
  fetchFn: typeof fetch = fetch,
  refresh: (dir: string) => Promise<CodexRefreshResult> = refreshCodexSubscription,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const attempt = async (token: string, accountId: string): Promise<Response> => {
      const headers = asHeaderRecord(init?.headers);
      headers.authorization = `Bearer ${token}`;
      headers.originator = codexOriginator(configDir);
      headers["user-agent"] = seriUserAgent();
      headers.session_id = sessionId;
      if (accountId.length > 0) headers["ChatGPT-Account-Id"] = accountId;
      return fetchFn(input, { ...init, headers });
    };

    const current = loadUsableCodexGrant(configDir);
    if (current === undefined) {
      throw new Error("No ChatGPT plan is connected. Run /setup to connect one.");
    }

    const first = await attempt(current.accessToken, current.accountId);
    if (first.status !== 401) return first;

    const refreshed = await refresh(configDir);
    if (refreshed.status !== "ok") return first;
    return attempt(refreshed.credential.accessToken, refreshed.credential.accountId);
  }) as typeof fetch;
}

export function getCodexSubscriptionModel(
  modelId: string,
  configDir: string,
  sessionId: string = randomUUID(),
  fetchFn: typeof fetch = fetch,
): LanguageModel {
  // ChatGPT-plan Responses has no storage; store:false must be a providerOptions value so getArgs also sets include: reasoning.encrypted_content.
  return wrapLanguageModel({
    model: createOpenAI({
      apiKey: UNUSED_PLACEHOLDER_KEY,
      baseURL: codexBaseUrl(configDir),
      fetch: codexAuthedFetch(configDir, sessionId, fetchFn) as typeof fetch,
    })(modelId),
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          openai: {
            ...params.providerOptions?.openai,
            store: false,
          },
        },
      }),
    },
  });
}
