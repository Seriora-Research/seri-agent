import { getApiKey } from "../config/config";
import {
  type DeviceAuthorization,
  type DeviceGrantResult,
  parseResponseBody,
  pollDeviceGrant,
} from "./deviceGrant";



export const XAI_ISSUER_DEFAULT = "https://auth.x.ai";



export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";





export const XAI_CLIENT_ID_DEFAULT = "b1a00492-073a-47ea-816f-4c329264a828";

export function xaiClientId(configDir?: string): string {
  return getApiKey("SERI_GROK_CLIENT_ID", configDir) ?? XAI_CLIENT_ID_DEFAULT;
}

export function xaiIssuer(configDir?: string): string {
  return getApiKey("SERI_GROK_ISSUER", configDir) ?? XAI_ISSUER_DEFAULT;
}

export type XaiEndpoints = {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
};

export function xaiUserinfoUrl(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/oauth2/userinfo`;
}


export function validXaiAccountId(accountId: string): boolean {
  if (accountId.length === 0 || accountId.length > 1024) return false;
  for (let i = 0; i < accountId.length; i++) {
    const code = accountId.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

export async function fetchXaiAccountId(
  accessToken: string,
  userinfoEndpoint: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchFn(userinfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`xAI userinfo failed with status ${response.status}`);
  }
  const body = await parseResponseBody(response);
  const sub = body.sub;
  if (typeof sub !== "string" || !validXaiAccountId(sub)) {
    throw new Error("xAI userinfo returned no usable account id");
  }
  return sub;
}








export async function discoverXaiEndpoints(
  issuer: string,
  fetchFn: typeof fetch = fetch,
): Promise<XaiEndpoints> {
  const issuerUrl = new URL(issuer);
  const response = await fetchFn(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new Error(`OIDC discovery for ${issuer} failed with status ${response.status}`);
  }
  const body = await parseResponseBody(response);

  const pin = (name: string, value: unknown): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`OIDC discovery for ${issuer} returned no ${name}`);
    }


    // Origin, not host: a host-only check would accept http://auth.x.ai for an https issuer.
    if (new URL(value).origin !== issuerUrl.origin) {
      throw new Error(
        `OIDC discovery for ${issuer} returned a ${name} on a different origin (${value}) — refusing it`,
      );
    }
    return value;
  };

  return {
    deviceAuthorizationEndpoint: pin(
      "device_authorization_endpoint",
      body.device_authorization_endpoint,
    ),
    tokenEndpoint: pin("token_endpoint", body.token_endpoint),
    userinfoEndpoint: pin("userinfo_endpoint", body.userinfo_endpoint ?? xaiUserinfoUrl(issuer)),
  };
}

export async function requestXaiDeviceCode(
  clientId: string,
  endpoints: XaiEndpoints,
  fetchFn: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const response = await fetchFn(endpoints.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: XAI_SCOPE }).toString(),
  });
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(
      `xAI device authorization failed with status ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri),
    verificationUriComplete: String(body.verification_uri_complete ?? body.verification_uri),
    expiresIn: Number(body.expires_in),
    interval: Number(body.interval),
  };
}

export type XaiTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  scope?: string;
};



export function readXaiTokens(payload: Record<string, unknown>): XaiTokens {
  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("xAI token response carried no access_token");
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("xAI token response carried no refresh_token");
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
  };
}

export function pollForXaiToken(
  clientId: string,
  device: DeviceAuthorization,
  endpoints: XaiEndpoints,
  opts: {
    fetchFn?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<DeviceGrantResult<XaiTokens>> {
  return pollDeviceGrant(device, {
    tokenUrl: endpoints.tokenEndpoint,
    body: () =>
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.deviceCode,
        client_id: clientId,
      }),
    onSuccess: readXaiTokens,
    tierDeniedOn403: true,
    ...opts,
  });
}
