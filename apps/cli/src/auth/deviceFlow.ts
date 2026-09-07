import { getApiKey } from "../config/config";
import { type DeviceAuthorization, parseResponseBody, pollDeviceGrant } from "./deviceGrant";



export { parseResponseBody };



export const DEFAULT_WORKOS_CLIENT_ID = "client_01KZ1JXPZSYG07NQZBCPQAN46N";





export function getWorkosClientId(configDir?: string): string {
  return getApiKey("SERI_WORKOS_CLIENT_ID", configDir) ?? DEFAULT_WORKOS_CLIENT_ID;
}

const AUTHORIZE_DEVICE_URL = "https://api.workos.com/user_management/authorize/device";



export const AUTHENTICATE_URL = "https://api.workos.com/user_management/authenticate";

export type { DeviceAuthorization };

export type TokenResult =
  | {
      status: "success";
      accessToken: string;
      refreshToken: string;



      expiresIn?: number;
      user: { id: string; email: string };
    }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; message: string }





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


    if (result.status === "tier-denied") return { status: "error", message: result.message };
    return result;
  });
}
