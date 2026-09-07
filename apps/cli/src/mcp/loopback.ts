import { canonicalizeLoopbackHost } from "@seri/daemon-client";
import { MCP_CALLBACK_PATH, MCP_CALLBACK_PORTS, mcpCallbackUri } from "./authProvider";



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




// RFC 8252 native-app loopback: bind 127.0.0.1 only, never 0.0.0.0.
export const startCallbackServer: StartCallbackServer = async (opts) => {
  const ports = opts?.ports ?? MCP_CALLBACK_PORTS;
  const callbackPath = opts?.path ?? MCP_CALLBACK_PATH;
  const redirectHost = canonicalizeLoopbackHost(opts?.redirectHost ?? "127.0.0.1");
  let active: ActiveWait | undefined;
  let stopped = false;


  let listener: { server: ReturnType<typeof Bun.serve>; port: number } | undefined;

  function close(): void {
    if (stopped) return;
    stopped = true;



    listener?.server.stop();
  }

  function handle(req: Request): Response {
    const url = new URL(req.url);


    if (req.method !== "GET" || url.pathname !== callbackPath) {
      return new Response("Not found", { status: 404 });
    }


    const wait = active;
    if (wait === undefined) return new Response("Not found", { status: 404 });




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
