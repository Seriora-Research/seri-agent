import { getApiKey } from "../config/config";

// WorkOS AuthKit client ID (Staging environment). Deliberately not the Production
// environment's client ID: that environment has never been activated (no API keys, no
// auth methods enabled, no redirect URIs), so its hosted sign-in page offers only SSO
// and dead-ends on a 404 after authenticating — verified live, 2026-08-02. Switch to
// Production's client ID once that environment is fully configured in the WorkOS
// dashboard. Not a secret: an OAuth public-client id is meant to ship inside the binary.
export const DEFAULT_WORKOS_CLIENT_ID = "client_01KZ1JXPJK16ADCG718H7C6VRM";

// Resolved through the same env-var-then-config.json lookup used for provider API keys
// (config/config.ts), so pointing the CLI at a different WorkOS environment — e.g.
// verifying Production before committing to it — doesn't require editing this file and
// rebuilding the binary.
export function getWorkosClientId(configDir?: string): string {
  return getApiKey("SERI_WORKOS_CLIENT_ID", configDir) ?? DEFAULT_WORKOS_CLIENT_ID;
}

const AUTHORIZE_DEVICE_URL = "https://api.workos.com/user_management/authorize/device";
// Exported so auth/refresh.ts's grant_type=refresh_token POST hits the same endpoint rather
// than duplicating the literal.
export const AUTHENTICATE_URL = "https://api.workos.com/user_management/authenticate";

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type TokenResult =
  | {
      status: "success";
      accessToken: string;
      refreshToken: string;
      // Optional: WorkOS's real device-flow token response carries no expires_in field at all
      // (confirmed live) — this is not a malformed response, it is the normal shape. Callers
      // must treat a missing value as "no expiry hint available", never as an error.
      expiresIn?: number;
      user: { id: string; email: string };
    }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; message: string }
  // Bug fix (thermo-nuclear, round 5): distinct from every other terminal status above — an
  // abandoned login (Escape on "starting"/"device", tui/routes/config/AuthPanel.tsx) is a deliberate
  // cancellation, not a failure, so it must never reach saveAuthSession NOR produce an error
  // message the way "denied"/"expired"/"error" all do (createAuthHandlers' own catch,
  // tui/handlers.ts).
  | { status: "aborted" };

// Exported so auth/refresh.ts's refreshAccessToken reuses this instead of a verbatim copy.
export async function parseResponseBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

export async function requestDeviceCode(
  clientId: string,
  fetchFn: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const response = await fetchFn(AUTHORIZE_DEVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  // WorkOS's own response fields are trusted directly, same as every other field this file
  // reads off a real WorkOS response — the typed Record<string, unknown> return above is for
  // refresh.ts's own already-checked usage, not a new validation requirement here.
  const body: any = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(
      `WorkOS device authorization failed with status ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
    expiresIn: body.expires_in,
    interval: body.interval,
  };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A function, not an inlined `signal?.aborted === true` at each call site: TS's control-flow
// narrowing treats a property read as stable across an `await` within the same scope (it isn't,
// for a mutable external AbortSignal — `.aborted` can flip between either check below) and
// narrows the second read to `false | undefined`, a real type error, not just an unnecessary
// check. A function call is an opaque boundary narrowing can't see through.
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function pollForToken(
  clientId: string,
  device: DeviceAuthorization,
  opts: {
    fetchFn?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    // Bug fix (thermo-nuclear, round 5): real cancellation, not just a caller-side "ignore the
    // eventual result" guard — without this, an abandoned login kept polling in the background
    // (a device code stays valid for minutes) and could still call saveAuthSession later, past
    // even an explicit /logout, since nothing else ever stopped it.
    signal?: AbortSignal;
  } = {},
): Promise<TokenResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const signal = opts.signal;

  let interval = device.interval;
  const deadline = now() + device.expiresIn * 1000;

  while (true) {
    if (now() >= deadline) return { status: "expired" };
    if (isAborted(signal)) return { status: "aborted" };

    await sleep(interval * 1000);

    const response = await fetchFn(AUTHENTICATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.deviceCode,
        client_id: clientId,
      }).toString(),
    });
    const body: any = await parseResponseBody(response);
    // Re-checked here, not just at the top of the loop: an abort that lands WHILE this iteration's
    // own sleep+fetch is already in flight (the exact race a real WorkOS poll can hit, since a
    // device code stays valid for minutes) must still discard whatever this poll just resolved to
    // — including a genuine "success" — rather than acting on it one iteration late.
    if (isAborted(signal)) return { status: "aborted" };

    if (response.ok) {
      return {
        status: "success",
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresIn: body.expires_in,
        user: { id: body.user.id, email: body.user.email },
      };
    }

    if (body.error === "authorization_pending") continue;
    // RFC 8628: on slow_down, increase the polling interval by (at least) 5 seconds.
    if (body.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (body.error === "expired_token") return { status: "expired" };
    if (body.error === "access_denied") return { status: "denied" };
    // Any other terminal error (invalid_request/invalid_client/a transient 5xx/...) stops
    // polling but is distinct from a real user denial.
    return {
      status: "error",
      message: `WorkOS returned an unexpected error during authentication: ${body.error ?? response.status}`,
    };
  }
}
