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

export type StartCallbackServer = (opts?: { ports?: readonly number[] }) => Promise<CallbackServer>;

const SUCCESS_PAGE =
  "<!doctype html><meta charset=utf-8><title>seri</title>" +
  "<p>Authentication complete. You can close this tab and go back to seri.</p>";

const DENIED_PAGE =
  "<!doctype html><meta charset=utf-8><title>seri</title>" +
  "<p>Authentication was declined. You can close this tab and go back to seri.</p>";

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
    // A browser asks for /favicon.ico on its own, and a 404 for it must not look like a callback.
    if (req.method !== "GET" || url.pathname !== MCP_CALLBACK_PATH) {
      return new Response("Not found", { status: 404 });
    }
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
