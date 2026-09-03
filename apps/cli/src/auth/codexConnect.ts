import { startCallbackServer, type StartCallbackServer } from "../mcp/loopback";
import { openBrowser } from "./browser";
import {
  clearCodexSubscription,
  hasLeftoverCodexSubscription,
  saveCodexSubscription,
  subscriptionFromCodexTokens,
} from "./codexAuthStore";
import { ignoreCodexSubscription } from "./codexIgnore";
import {
  buildCodexAuthorizeUrl,
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORTS,
  CODEX_LOGIN_TIMEOUT_MS,
  codexClientId,
  codexIssuer,
  codexTokenUrl,
  exchangeCodexAuthorizationCode,
  extractCodexAccountId,
  pkceChallenge,
  pkceVerifier,
} from "./codexOAuth";

export const CODEX_BORROWED_CLIENT_WARNING =
  "This uses Codex CLI's OAuth client id, which seri does not own. Traffic from the connected account is attributed to that id. If OpenAI rate-limits, revokes, or rotates it, this subscription stops working, and every other harness using the same id breaks at the same moment.";

export async function connectCodex(
  configDir: string,
  deps: {
    startCallback?: StartCallbackServer;
    openBrowser?: typeof openBrowser;
    exchangeCode?: typeof exchangeCodexAuthorizationCode;
    extractAccountId?: typeof extractCodexAccountId;
    onAuthorizeUrl?: (url: string) => void;
    onMessage?: (message: string) => void;
    signal?: AbortSignal;
    fetchFn?: typeof fetch;
  } = {},
): Promise<void> {
  const startCallback = deps.startCallback ?? startCallbackServer;
  const openBrowserFn = deps.openBrowser ?? openBrowser;
  const exchangeCode = deps.exchangeCode ?? exchangeCodexAuthorizationCode;
  const extractAccountId = deps.extractAccountId ?? extractCodexAccountId;
  const onMessage = deps.onMessage ?? console.log;

  const clientId = codexClientId(configDir);
  const issuer = codexIssuer(configDir);
  const tokenUrl = codexTokenUrl(configDir);
  const verifier = pkceVerifier();
  const state = pkceVerifier();

  const server = await startCallback({
    ports: CODEX_CALLBACK_PORTS,
    path: CODEX_CALLBACK_PATH,
    redirectHost: "localhost",
    fallbackEphemeral: true,
  });

  try {
    if (deps.signal?.aborted === true) return;

    const redirectUri = server.redirectUri;
    const authorizeUrl = buildCodexAuthorizeUrl({
      issuer,
      clientId,
      redirectUri,
      codeChallenge: pkceChallenge(verifier),
      state,
    });

    const onAuthorizeUrl =
      deps.onAuthorizeUrl ??
      ((url: string) => {
        console.log(`To continue, open: ${url}`);
      });
    onAuthorizeUrl(authorizeUrl);
    openBrowserFn(authorizeUrl);

    const wait = await server.waitForCallback({
      expectedState: state,
      timeoutMs: CODEX_LOGIN_TIMEOUT_MS,
      signal: deps.signal,
    });

    if (wait.kind === "aborted") return;
    if (wait.kind === "timeout") {
      throw new Error("The ChatGPT connect request expired. Please try again.");
    }
    if (wait.kind === "denied") {
      throw new Error(wait.message.length > 0 ? wait.message : "Authorization was denied.");
    }

    const tokens = await exchangeCode(
      {
        tokenUrl,
        clientId,
        code: wait.code,
        codeVerifier: verifier,
        redirectUri,
      },
      deps.fetchFn,
    );
    const accountId = extractAccountId(tokens.accessToken);
    saveCodexSubscription(subscriptionFromCodexTokens({ ...tokens, accountId }), configDir);
    onMessage("Connected ChatGPT plan.");
  } finally {
    server.close();
  }
}

export function disconnectCodex(
  configDir: string,
  onMessage: (message: string) => void = console.log,
): void {
  clearCodexSubscription(configDir);
  if (hasLeftoverCodexSubscription()) ignoreCodexSubscription(configDir);
  onMessage(
    "Disconnected ChatGPT plan. seri's local credential is gone; ~/.codex/auth.json was not touched.",
  );
}
