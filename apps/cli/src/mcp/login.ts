// Touches the network, through auth() (@ai-sdk/mcp) rather than directly: discovery, dynamic
// client registration and the token exchange are all its calls, and this file only opens the
// listener the redirect lands on, opens a browser, and reports which of the five ways one login
// can end actually happened.
import { auth } from "@ai-sdk/mcp";
import { openBrowser } from "../auth/browser";
import { messageOf } from "../errors";
import { createMcpAuthProvider } from "./authProvider";
import { type CallbackServer, type StartCallbackServer, startCallbackServer } from "./loopback";
import type { McpServerSpec } from "./types";

// Five minutes. A consent screen can involve a password manager, a second device and reading a
// scope list, and the only cost of waiting is a bound loopback port.
export const MCP_LOGIN_TIMEOUT_MS = 300_000;

export type McpLoginResult =
  | { readonly status: "success" }
  | { readonly status: "denied"; readonly message: string }
  | { readonly status: "timeout" }
  | { readonly status: "aborted" }
  | { readonly status: "error"; readonly message: string };

// Never throws — every ending is a result. Both call sites (the /mcp panel and the /mcp auth slash
// form, cli.ts) put this on one transcript line, and a stack trace is not that line.
export async function loginMcpServer(
  spec: McpServerSpec,
  configDir: string,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onMessage?: (line: string) => void;
    openUrl?: (url: string) => void;
    listen?: StartCallbackServer;
    authFn?: typeof auth;
    fetchFn?: typeof fetch;
  } = {},
): Promise<McpLoginResult> {
  const {
    signal,
    timeoutMs = MCP_LOGIN_TIMEOUT_MS,
    onMessage,
    openUrl = (url: string) => openBrowser(url),
    listen = startCallbackServer,
    authFn = auth,
    fetchFn,
  } = opts;

  let server: CallbackServer | undefined;
  try {
    // Bound before the provider exists, because the provider's redirectUrl has to name the port
    // that actually bound — and auth() reaches redirectToAuthorization inside its own call below,
    // so the browser can arrive at that port moments later.
    server = await listen({ serverName: spec.name });
    const provider = createMcpAuthProvider({
      spec,
      configDir,
      interaction: {
        kind: "redirect",
        redirectUri: server.redirectUri,
        onRedirect: (url) => {
          // Printed as well as opened: a headless machine, a broken xdg-open or a browser that
          // opens in the wrong profile all leave the URL as the only way through, and openBrowser
          // is best-effort by design (auth/browser.ts).
          onMessage?.(`Authenticating "${spec.name}". If your browser did not open: ${url.href}`);
          openUrl(url.href);
        },
      },
    });

    // A stored refresh token that still works never reaches a browser at all: auth() returns
    // AUTHORIZED from this first call and there is no redirect to wait for.
    if ((await authFn(provider, { serverUrl: spec.url, fetchFn })) === "AUTHORIZED") {
      return { status: "success" };
    }

    const waited = await server.waitForCallback({
      expectedState: await provider.storedState?.(),
      timeoutMs,
      signal,
    });
    if (waited.kind === "denied") return { status: "denied", message: waited.message };
    if (waited.kind === "timeout") return { status: "timeout" };
    if (waited.kind === "aborted") return { status: "aborted" };

    const exchanged = await authFn(provider, {
      serverUrl: spec.url,
      authorizationCode: waited.code,
      callbackState: waited.state,
      callbackIssuer: waited.iss,
      fetchFn,
    });
    return exchanged === "AUTHORIZED"
      ? { status: "success" }
      : { status: "error", message: `authenticating "${spec.name}" did not complete` };
  } catch (err) {
    return { status: "error", message: messageOf(err) };
  } finally {
    // Every exit path, including the one where listen() itself failed and there is nothing to
    // close: a listener left bound would hold a registered redirect port for the rest of the run.
    server?.close();
  }
}
