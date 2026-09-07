



import { auth } from "@ai-sdk/mcp";
import { openBrowser } from "../auth/browser";
import { messageOf } from "../errors";
import { createMcpAuthProvider } from "./authProvider";
import { type CallbackServer, type StartCallbackServer, startCallbackServer } from "./loopback";
import type { McpServerSpec } from "./types";



export const MCP_LOGIN_TIMEOUT_MS = 300_000;

export type McpLoginResult =
  | { readonly status: "success" }
  | { readonly status: "denied"; readonly message: string }
  | { readonly status: "timeout" }
  | { readonly status: "aborted" }
  | { readonly status: "error"; readonly message: string };



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



    server = await listen();
    const provider = createMcpAuthProvider({
      spec,
      configDir,
      interaction: {
        kind: "redirect",
        redirectUri: server.redirectUri,
        onRedirect: (url) => {



          onMessage?.(`Authenticating "${spec.name}". If your browser did not open: ${url.href}`);
          openUrl(url.href);
        },
      },
    });



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


    server?.close();
  }
}
