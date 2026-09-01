import { openBrowser } from "./browser";
import {
  clearXaiSubscription,
  saveXaiSubscription,
  subscriptionFromTokens,
} from "./xaiAuthStore";
import {
  discoverXaiEndpoints,
  fetchXaiAccountId,
  pollForXaiToken,
  requestXaiDeviceCode,
  xaiClientId,
  xaiIssuer,
} from "./xaiOAuth";

export const GROK_BORROWED_CLIENT_WARNING =
  "This uses Grok Build's OAuth client id, which seri does not own. Traffic from the connected account is attributed to that id. If xAI rate-limits, revokes, or rotates it, this subscription stops working, and every other harness using the same id breaks at the same moment.";

export async function connectGrok(
  configDir: string,
  deps: {
    requestDeviceCode?: typeof requestXaiDeviceCode;
    discover?: typeof discoverXaiEndpoints;
    fetchAccountId?: typeof fetchXaiAccountId;
    openBrowser?: typeof openBrowser;
    pollForToken?: typeof pollForXaiToken;
    onDeviceCode?: (device: { verificationUri: string; userCode: string }) => void;
    onMessage?: (message: string) => void;
    signal?: AbortSignal;
    fetchFn?: typeof fetch;
  } = {},
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const requestDeviceCodeFn = deps.requestDeviceCode ?? requestXaiDeviceCode;
  const discoverFn = deps.discover ?? discoverXaiEndpoints;
  const fetchAccountIdFn = deps.fetchAccountId ?? fetchXaiAccountId;
  const openBrowserFn = deps.openBrowser ?? openBrowser;
  const pollForTokenFn = deps.pollForToken ?? pollForXaiToken;
  const onDeviceCode =
    deps.onDeviceCode ??
    ((device: { verificationUri: string; userCode: string }) => {
      console.log(`To continue, open: ${device.verificationUri}`);
      console.log(`And enter code: ${device.userCode}`);
    });
  const onMessage = deps.onMessage ?? console.log;

  const clientId = xaiClientId(configDir);
  const endpoints = await discoverFn(xaiIssuer(configDir), fetchFn);
  const device = await requestDeviceCodeFn(clientId, endpoints, fetchFn);

  if (deps.signal?.aborted === true) {
    return;
  }

  onDeviceCode({ verificationUri: device.verificationUri, userCode: device.userCode });
  openBrowserFn(device.verificationUriComplete);

  const result = await pollForTokenFn(clientId, device, endpoints, {
    fetchFn,
    signal: deps.signal,
  });

  if (result.status === "aborted") {
    return;
  }
  if (result.status === "denied") {
    throw new Error("Authorization was denied.");
  }
  if (result.status === "expired") {
    throw new Error("The Grok connect request expired. Please try again.");
  }
  if (result.status === "tier-denied") {
    throw new Error(result.message);
  }
  if (result.status === "error") {
    throw new Error(result.message);
  }

  const accountId = await fetchAccountIdFn(
    result.value.accessToken,
    endpoints.userinfoEndpoint,
    fetchFn,
  );
  saveXaiSubscription(subscriptionFromTokens({ ...result.value, accountId }), configDir);
  onMessage("Connected Grok subscription.");
}

export function disconnectGrok(
  configDir: string,
  onMessage: (message: string) => void = console.log,
): void {
  clearXaiSubscription(configDir);
  onMessage(
    "Disconnected Grok subscription. seri's local credential is gone; access at xAI was not revoked.",
  );
}
