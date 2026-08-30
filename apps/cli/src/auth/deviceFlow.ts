import { getApiKey } from "../config/config";
import { type DeviceAuthorization, parseResponseBody, pollDeviceGrant } from "./deviceGrant";

// Re-exported so auth/refresh.ts keeps importing it from here, where it has always lived as far
// as that module is concerned.
export { parseResponseBody };

// WorkOS AuthKit client ID (Production environment). Not a secret: an OAuth public-client id
// is meant to ship inside the binary.
export const DEFAULT_WORKOS_CLIENT_ID = "client_01KZ1JXPZSYG07NQZBCPQAN46N";

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

export type { DeviceAuthorization };

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

export function pollForToken(
  clientId: string,
  device: DeviceAuthorization,
  opts: {
    fetchFn?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    // Bug fix (thermo-nuclear, round 5): real cancellation, not just a caller-side "ignore the
    // eventual result" guard — without this, an abandoned login kept polling in the background
    // (a device code stays valid for minutes) and could still call saveAuthSession later, past
    // even an explicit /logout, since nothing else ever stopped it. The loop that honours it now
    // lives in deviceGrant.ts, shared with the xAI subscription flow.
    signal?: AbortSignal;
  } = {},
): Promise<TokenResult> {
  return pollDeviceGrant(device, {
    tokenUrl: AUTHENTICATE_URL,
    body: () =>
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.deviceCode,
        client_id: clientId,
      }),
    // WorkOS's own response fields are trusted directly, same as every other field this file
    // reads off a real WorkOS response.
    onSuccess: (body: any) => ({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
      user: { id: body.user.id, email: body.user.email },
    }),
    describeError: (raw) => `WorkOS returned an unexpected error during authentication: ${raw}`,
    ...opts,
  }).then((result): TokenResult => {
    if (result.status === "success") return { status: "success", ...result.value };
    // WorkOS has no subscription tier, so a 403 from it is just another unexpected terminal
    // error — mapped back rather than surfaced as a state /login has no meaning for.
    if (result.status === "tier-denied") return { status: "error", message: result.message };
    return result;
  });
}
