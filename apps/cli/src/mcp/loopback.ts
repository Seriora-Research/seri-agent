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
  serverName?: string;
}) => Promise<CallbackServer>;

// A server name reaches this page from servers.yaml, where NAME_SHAPE (mcp/registry.ts) already
// confines it to lowercase letters, digits and "-". Escaped anyway: this is the one string on the
// page seri did not write, the shape rule lives in a different module, and a page that only stays
// safe while a regex two files away holds is not worth the coupling.
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Ink on canvas with no accent hue, the palette docs/design/tokens.md defines for seri's web
// surfaces, inverted under prefers-color-scheme: dark. Every value is inline and no font is
// fetched: this page is served by a loopback listener that closes moments later, so a request to
// a CDN would be a blocked or slow one on the last screen of a login, and a webfont on a page
// this short would swap after the user has already read it.
function callbackPage(opts: { heading: string; detail: string; serverName?: string }): string {
  const named = opts.serverName === undefined ? "" : ` <b>${escapeHtml(opts.serverName)}</b>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>seri</title>
<style>
:root { --ink:#141413; --canvas:#faf9f5; --subtle:rgba(20,20,19,.64); --hairline:rgba(20,20,19,.14) }
@media (prefers-color-scheme:dark) {
  :root { --ink:#faf9f5; --canvas:#141413; --subtle:rgba(250,249,245,.68); --hairline:rgba(250,249,245,.16) }
}
* { box-sizing:border-box }
body {
  margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
  background:var(--canvas); color:var(--ink); padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased;
}
main { max-width:26rem; width:100% }
.mark {
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--subtle);
  padding-bottom:14px; margin-bottom:22px; border-bottom:1px solid var(--hairline);
}
h1 { font-size:19px; font-weight:600; margin:0 0 8px; letter-spacing:-.01em }
p { margin:0; color:var(--subtle) }
b { font-weight:600; color:var(--ink) }
</style>
<main>
  <div class="mark">seri</div>
  <h1>${opts.heading}${named}</h1>
  <p>${opts.detail}</p>
</main>
</html>`;
}

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
  const serverName = opts?.serverName;
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
    if (req.method !== "GET" || url.pathname !== MCP_CALLBACK_PATH) {
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
      return page(
        callbackPage({
          heading: "Authentication was declined for",
          detail: "Nothing was saved. You can close this tab and go back to seri.",
          serverName,
        }),
      );
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
    return page(
      callbackPage({
        heading: "Authenticated",
        detail: "You can close this tab and go back to seri.",
        serverName,
      }),
    );
  }

  for (const port of ports) {
    try {
      listener = { server: Bun.serve({ hostname: "127.0.0.1", port, fetch: handle }), port };
      break;
    } catch {
      // Another application, or another seri login, already holds this one. Every candidate is a
      // registered redirect URI (clientMetadata, mcp/authProvider.ts), so the next one works
      // without re-registering anything and without persisting the choice.
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
  const redirectUri = mcpCallbackUri(listener.port);

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
