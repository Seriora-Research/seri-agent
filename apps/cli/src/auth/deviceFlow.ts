// WorkOS AuthKit client ID (Staging environment). Deliberately not the Production
// environment's client ID: that environment has never been activated (no API keys, no
// auth methods enabled, no redirect URIs), so its hosted sign-in page offers only SSO
// and dead-ends on a 404 after authenticating — verified live, 2026-08-02. Switch to
// Production's client ID once that environment is fully configured in the WorkOS
// dashboard.
export const DEFAULT_WORKOS_CLIENT_ID = "client_01KZ1JXPJK16ADCG718H7C6VRM";

const AUTHORIZE_DEVICE_URL = "https://api.workos.com/user_management/authorize/device";
const AUTHENTICATE_URL = "https://api.workos.com/user_management/authenticate";

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type TokenResult =
  | { status: "success"; accessToken: string; refreshToken: string; user: { id: string; email: string } }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; message: string };

async function parseResponseBody(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

export async function requestDeviceCode(clientId: string, fetchFn: typeof fetch = fetch): Promise<DeviceAuthorization> {
  const response = await fetchFn(AUTHORIZE_DEVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(`WorkOS device authorization failed with status ${response.status}: ${JSON.stringify(body)}`);
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

export async function pollForToken(
  clientId: string,
  device: DeviceAuthorization,
  opts: { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<TokenResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;

  let interval = device.interval;
  const deadline = now() + device.expiresIn * 1000;

  while (true) {
    if (now() >= deadline) return { status: "expired" };

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
    const body = await parseResponseBody(response);

    if (response.ok) {
      return {
        status: "success",
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
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
    return { status: "error", message: `WorkOS returned an unexpected error during authentication: ${body.error ?? response.status}` };
  }
}
