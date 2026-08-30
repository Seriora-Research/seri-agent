import { getApiKey } from "../config/config";
import {
  type DeviceAuthorization,
  type DeviceGrantResult,
  parseResponseBody,
  pollDeviceGrant,
} from "./deviceGrant";

// xAI's OAuth issuer. Overridable through the same env-then-config lookup getWorkosClientId uses,
// so an enterprise OIDC deployment can point at its own IdP without a rebuild.
export const XAI_ISSUER_DEFAULT = "https://auth.x.ai";

// Everything the official client asks for, minus nothing: `offline_access` is what makes a refresh
// token available at all, and `grok-cli:access` is what the inference surface checks.
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";

// DELIBERATELY NO DEFAULT. xAI allowlists OAuth client ids and publishes no third-party
// registration, so the only id known to work belongs to someone else. Shipping it would be the
// client impersonation issue #209 rules out, and it would attribute seri's traffic to another
// party's registration. Absent means the connect flow is unreachable and no request is ever made.
// See docs/specs/040-grok-subscription/research.md for the probe evidence.
export function xaiClientId(configDir?: string): string | undefined {
  return getApiKey("SERI_GROK_CLIENT_ID", configDir);
}

export function xaiIssuer(configDir?: string): string {
  return getApiKey("SERI_GROK_ISSUER", configDir) ?? XAI_ISSUER_DEFAULT;
}

export type XaiEndpoints = {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
};

// Discovery is re-fetched rather than persisted: a cached endpoint that goes stale is a hard
// failure with no recovery path, while a re-discovered one self-heals.
//
// Origin-pinned on purpose. A poisoned or hijacked discovery document could otherwise redirect
// refresh traffic — which carries a long-lived, rotating refresh token — to an attacker's host,
// or downgrade it to http on the right one. Every endpoint must share the issuer's own origin or
// discovery fails closed.
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
    // Origin, not host: a host-only check would accept http://auth.x.ai for an https issuer,
    // which downgrades the channel carrying a rotating refresh token.
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

// Both token fields are required before a result counts as success. A 200 carrying a partial pair
// would otherwise be persisted and leave the connection unable to ever refresh itself.
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
