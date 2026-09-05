import { canonicalizeLoopbackHost } from "@seri/daemon-client";
import { MCP_CALLBACK_PATH, MCP_CALLBACK_PORTS, mcpCallbackUri } from "./authProvider";

// Every way one login can end. `denied` carries the authorization server's own error_description,
// which is the only text that can explain a refusal seri had no part in.
export type McpCallbackWait =
  | { readonly kind: "code"; readonly code: string; readonly state?: string; readonly iss?: string }
  | { readonly kind: "denied"; readonly message: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

export type CallbackServer = {
  readonly redirectUri: string;
  waitForCallback(opts: {
    expectedState: string | undefined;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<McpCallbackWait>;
  close(): void;
};

export type StartCallbackServer = (opts?: {
  ports?: readonly number[];
  path?: string;
  redirectHost?: string;
  fallbackEphemeral?: boolean;
}) => Promise<CallbackServer>;

// Ink on canvas with no accent hue, the palette docs/design/tokens.md defines for seri's web
// surfaces, inverted under prefers-color-scheme: dark. Every value is inline and no font is
// fetched: this page is served by a loopback listener that closes moments later, so a request to
// a CDN would be a blocked or slow one on the last screen of a login, and a webfont on a page
// this short would swap after the user has already read it.
//
// Both strings are constants and neither names the server, which leaves no text on the page that
// seri did not write and so nothing here to escape.
function callbackPage(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>seri</title>
<style>
:root { color-scheme:light dark; --ink:#141413; --canvas:#faf9f5; --subtle:rgba(20,20,19,.64) }
@media (prefers-color-scheme:dark) {
  :root { --ink:#faf9f5; --canvas:#141413; --subtle:rgba(250,249,245,.68) }
}
body {
  margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
  background:var(--canvas); color:var(--ink);
  font:15px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
}
main { text-align:center; padding:2rem; max-width:26rem }
h1 { margin:0 0 .5rem; font-size:1.125rem; font-weight:600; letter-spacing:-.01em }
p { margin:0; font-size:.875rem; color:var(--subtle) }
</style>
<main><h1>${title}</h1><p>${detail}</p></main>
</html>`;
}

const SUCCESS_PAGE = callbackPage(
  "Authorization complete",
  "Returning you to seri. You can close this tab.",
);

const DENIED_PAGE = callbackPage("Authorization failed", "Return to seri for details.");

function page(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

type ActiveWait = {
  readonly expectedState: string | undefined;
  readonly settle: (result: McpCallbackWait) => void;
};

// The loopback half of RFC 8252's native-app flow: a listener this process holds open for the one
// redirect, on 127.0.0.1 only — never 0.0.0.0, which would put someone else's authorization code
// within reach of anything else on the network.
export const startCallbackServer: StartCallbackServer = async (opts) => {
  const ports = opts?.ports ?? MCP_CALLBACK_PORTS;
  const callbackPath = opts?.path ?? MCP_CALLBACK_PATH;
  const redirectHost = canonicalizeLoopbackHost(opts?.redirectHost ?? "127.0.0.1");
  let active: ActiveWait | undefined;
  let stopped = false;
  // Carries the port alongside the server because Server.port is `number | undefined` (a
  // unix-socket server has none) while the redirect URI needs a number.
  let listener: { server: ReturnType<typeof Bun.serve>; port: number } | undefined;

  function close(): void {
    if (stopped) return;
    stopped = true;
    // Graceful: cancelling a login can race the callback that is already being served, and
    // dropping that connection mid-response would leave the browser on an error page for a login
    // that actually succeeded.
    listener?.server.stop();
  }

  function handle(req: Request): Response {
    const url = new URL(req.url);
    // Exactly one path is the redirect. A browser fetches /favicon.ico off its own bat, and
    // treating whatever arrives on this port as the callback would settle the login on it.
    if (req.method !== "GET" || url.pathname !== callbackPath) {
      return new Response("Not found", { status: 404 });
    }
    // No wait is active before waitForCallback is called and after it has settled, and there is no
    // expected state to check a request against in either window.
    const wait = active;
    if (wait === undefined) return new Response("Not found", { status: 404 });

    // A stray request from something else on this machine must not burn the one redirect this
    // listener exists for, so a mismatched state is refused on the spot and the wait stays open
    // for the real callback rather than resolving on the impostor.
    if (wait.expectedState !== undefined && url.searchParams.get("state") !== wait.expectedState) {
      return new Response("Unexpected OAuth state.", { status: 400 });
    }

    const error = url.searchParams.get("error");
    if (error !== null) {
      wait.settle({
        kind: "denied",
        message: url.searchParams.get("error_description") ?? error,
      });
      close();
      return page(DENIED_PAGE);
    }

    const code = url.searchParams.get("code");
    if (code === null) return new Response("Missing the OAuth code.", { status: 400 });
    wait.settle({
      kind: "code",
      code,
      state: url.searchParams.get("state") ?? undefined,
      iss: url.searchParams.get("iss") ?? undefined,
    });
    close();
    return page(SUCCESS_PAGE);
  }

  for (const port of ports) {
    try {
      listener = { server: Bun.serve({ hostname: "127.0.0.1", port, fetch: handle }), port };
      break;
    } catch {
      // Port taken. MCP candidates are registered redirect URIs. Codex then tries 1457 and an
      // ephemeral port (fallbackEphemeral) that is not pre-registered.
    }
  }
  if (listener === undefined && opts?.fallbackEphemeral === true) {
    const ephemeral = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
    if (ephemeral.port !== undefined) {
      listener = { server: ephemeral, port: ephemeral.port };
    } else {
      ephemeral.stop();
    }
  }
  if (listener === undefined) {
    throw new Error(
      `could not open an OAuth callback listener on any of ports ${ports.join(", ")}`,
    );
  }
  // A listener leaked by a path that never reached close() must not be what keeps seri running.
  // close() is still the real cleanup; this only removes the failure mode where it is missed.
  listener.server.unref();
  const redirectUri =
    opts?.path !== undefined || opts?.redirectHost !== undefined
      ? `http://${redirectHost}:${listener.port}${callbackPath}`
      : mcpCallbackUri(listener.port);

  function waitForCallback(waitOpts: {
    expectedState: string | undefined;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<McpCallbackWait> {
    // Total: the request, the signal and the timer all RESOLVE. A rejection here would reach
    // loginMcpServer (mcp/login.ts) as a thrown error and lose which of the three actually
    // happened, which is the whole distinction the caller reports to the user.
    return new Promise<McpCallbackWait>((resolve) => {
      let settled = false;
      function settle(result: McpCallbackWait): void {
        if (settled) return;
        settled = true;
        active = undefined;
        clearTimeout(timer);
        waitOpts.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      }
      function onAbort(): void {
        settle({ kind: "aborted" });
      }
      const timer = setTimeout(() => settle({ kind: "timeout" }), waitOpts.timeoutMs);

      if (waitOpts.signal?.aborted === true) {
        settle({ kind: "aborted" });
        return;
      }
      waitOpts.signal?.addEventListener("abort", onAbort);
      active = { expectedState: waitOpts.expectedState, settle };
    });
  }

  return { redirectUri, waitForCallback, close };
};
