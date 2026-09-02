import { createHash, randomBytes } from "node:crypto";
import { getApiKey } from "../config/config";
import { parseResponseBody } from "./deviceGrant";

export const CODEX_ISSUER_DEFAULT = "https://auth.openai.com";
export const CODEX_TOKEN_URL_DEFAULT = "https://auth.openai.com/oauth/token";
export const CODEX_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CODEX_ORIGINATOR = "seri";
export const CODEX_CALLBACK_PATH = "/auth/callback";
export const CODEX_CALLBACK_PORTS: readonly number[] = [1455, 1457];
export const CODEX_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// Codex CLI's public OAuth client id. OpenAI allowlists OAuth clients and has not issued seri
// one, so this is borrowed. Traffic from a connected ChatGPT plan is attributed to an id seri
// does not own; if OpenAI rate-limits, revokes, or rotates it, the user's plan is what stops
// working. SERI_CODEX_CLIENT_ID still overrides it. /setup must say this before the browser opens.
export const CODEX_CLIENT_ID_DEFAULT = "app_EMoamEEZ73f0CkXaXp7hrann";

const AUTH_CLAIM = "https://api.openai.com/auth";

export function codexClientId(configDir?: string): string {
  return getApiKey("SERI_CODEX_CLIENT_ID", configDir) ?? CODEX_CLIENT_ID_DEFAULT;
}

export function codexIssuer(configDir?: string): string {
  return getApiKey("SERI_CODEX_ISSUER", configDir) ?? CODEX_ISSUER_DEFAULT;
}

export function codexTokenUrl(configDir?: string): string {
  return getApiKey("SERI_CODEX_TOKEN_URL", configDir) ?? CODEX_TOKEN_URL_DEFAULT;
}

export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function codexRedirectUri(port: number): string {
  return `http://localhost:${port}${CODEX_CALLBACK_PATH}`;
}

export function buildCodexAuthorizeUrl(opts: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  originator?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: CODEX_SCOPE,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: opts.state,
    originator: opts.originator ?? CODEX_ORIGINATOR,
  });
  return `${opts.issuer.replace(/\/$/, "")}/oauth/authorize?${params.toString()}`;
}

export type CodexTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
};

export function readCodexTokens(payload: Record<string, unknown>): CodexTokens {
  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("ChatGPT token response carried no access_token");
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("ChatGPT token response carried no refresh_token");
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
  };
}

export function readCodexRefreshTokens(
  payload: Record<string, unknown>,
  previousRefreshToken: string,
): CodexTokens {
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("ChatGPT token response carried no access_token");
  }
  const rotated = payload.refresh_token;
  const refreshToken =
    typeof rotated === "string" && rotated.length > 0 ? rotated : previousRefreshToken;
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
  };
}

export function extractCodexAccountId(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) {
    throw new Error("ChatGPT access token is not a JWT");
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("ChatGPT access token payload is not JSON");
  }
  if (typeof json !== "object" || json === null) {
    throw new Error("ChatGPT access token payload is not an object");
  }
  const claim = (json as Record<string, unknown>)[AUTH_CLAIM];
  if (typeof claim !== "object" || claim === null) {
    throw new Error("ChatGPT access token has no auth claim");
  }
  const accountId = (claim as Record<string, unknown>).chatgpt_account_id;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("ChatGPT access token has no chatgpt_account_id");
  }
  return accountId;
}

export async function exchangeCodexAuthorizationCode(
  opts: {
    tokenUrl: string;
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  fetchFn: typeof fetch = fetch,
): Promise<CodexTokens> {
  const response = await fetchFn(opts.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: opts.clientId,
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
    }).toString(),
  });
  const payload = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(
      `ChatGPT authorization-code exchange failed with status ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return readCodexTokens(payload);
}

export async function refreshCodexGrant(
  opts: {
    tokenUrl: string;
    clientId: string;
    refreshToken: string;
  },
  fetchFn: typeof fetch = fetch,
): Promise<CodexTokens> {
  const response = await fetchFn(opts.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: opts.clientId,
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
    }),
  });
  const payload = await parseResponseBody(response);
  if (response.status === 403) {
    const error = new Error(
      String(payload.error_description ?? payload.error ?? "Plan tier not allowed"),
    );
    error.name = "CodexTierDenied";
    throw error;
  }
  if (payload.error === "invalid_grant") {
    const error = new Error(
      "Your ChatGPT plan session has expired. Connect it again from /setup.",
    );
    error.name = "CodexReconnectRequired";
    throw error;
  }
  if (!response.ok) {
    throw new Error(`ChatGPT refresh failed: ${payload.error ?? response.status}`);
  }
  return readCodexRefreshTokens(payload, opts.refreshToken);
}
