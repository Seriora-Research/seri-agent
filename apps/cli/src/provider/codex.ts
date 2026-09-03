import { createOpenAI } from "@ai-sdk/openai";
import type { JSONValue } from "ai";
import type { LanguageModel } from "ai";
import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import pkg from "../../package.json";
import { refreshCodexSubscription, type CodexRefreshResult } from "../auth/codexRefresh";
import { loadUsableCodexGrant } from "../auth/codexAuthStore";
import { CODEX_BASE_URL_DEFAULT, CODEX_ORIGINATOR } from "../auth/codexOAuth";
import { getApiKey } from "../config/config";
import type { RouteCredential } from "./routing";

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

function withCodexRequestBody(body: BodyInit | null | undefined): BodyInit | undefined {
  if (typeof body !== "string") return body ?? undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
    return JSON.stringify({ ...(parsed as Record<string, unknown>), store: false, stream: true });
  } catch {
    return body;
  }
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
      return fetchFn(input, {
        ...init,
        headers,
        body: withCodexRequestBody(init?.body ?? null),
      });
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
  return createOpenAI({
    apiKey: UNUSED_PLACEHOLDER_KEY,
    baseURL: codexBaseUrl(configDir),
    fetch: codexAuthedFetch(configDir, sessionId, fetchFn) as typeof fetch,
  })(modelId);
}

export function withCodexStoreOption(
  provider: string | undefined,
  credential: RouteCredential | undefined,
  options: Record<string, Record<string, JSONValue>> | undefined,
): Record<string, Record<string, JSONValue>> | undefined {
  if (credential !== "subscription" || provider !== "openai") return options;
  return {
    openai: {
      ...(options?.openai ?? {}),
      store: false,
    },
  };
}
