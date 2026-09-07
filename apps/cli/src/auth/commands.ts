import { clearCachedAccountPlan } from "../provider/accountStatus";
import { clearUsageSnapshot } from "../usage/snapshot";
import { clearAuthSession, expiresAtFrom, loadAuthSession, saveAuthSession } from "./authStore";
import { openBrowser } from "./browser";
import { pollForToken, requestDeviceCode } from "./deviceFlow";
import { clearSeriIgnore } from "./seriIgnore";

export async function login(
  mode: "login" | "signup",
  clientId: string,
  configDir: string,
  deps: {
    requestDeviceCode?: typeof requestDeviceCode;
    openBrowser?: typeof openBrowser;
    pollForToken?: typeof pollForToken;






    onDeviceCode?: (device: { verificationUri: string; userCode: string }) => void;
    onMessage?: (message: string) => void;




    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const requestDeviceCodeFn = deps.requestDeviceCode ?? requestDeviceCode;
  const openBrowserFn = deps.openBrowser ?? openBrowser;
  const pollForTokenFn = deps.pollForToken ?? pollForToken;
  const onDeviceCode =
    deps.onDeviceCode ??
    ((device: { verificationUri: string; userCode: string }) => {
      console.log(`To continue, open: ${device.verificationUri}`);
      console.log(`And enter code: ${device.userCode}`);
    });
  const onMessage = deps.onMessage ?? console.log;

  const device = await requestDeviceCodeFn(clientId);







  if (deps.signal?.aborted === true) {
    return;
  }

  onDeviceCode({ verificationUri: device.verificationUri, userCode: device.userCode });
  openBrowserFn(device.verificationUriComplete);

  const result = await pollForTokenFn(clientId, device, { signal: deps.signal });



  if (result.status === "aborted") {
    return;
  }
  if (result.status === "denied") {
    throw new Error("Authorization was denied.");
  }
  if (result.status === "expired") {
    throw new Error("The login request expired. Please try again.");
  }
  if (result.status === "error") {
    throw new Error(result.message);
  }

  saveAuthSession(
    {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId: result.user.id,
      email: result.user.email,
      obtainedAt: new Date().toISOString(),
      expiresAt: expiresAtFrom(result.expiresIn),
    },
    configDir,
  );

  clearSeriIgnore(configDir);

  onMessage(
    mode === "signup"
      ? `Account created — logged in as ${result.user.email}`
      : `Logged in as ${result.user.email}`,
  );
}

export function logout(
  configDir: string,
  onMessage: (message: string) => void = console.log,
): void {
  const existing = loadAuthSession(configDir);
  clearAuthSession(configDir);
  clearUsageSnapshot(configDir);
  clearCachedAccountPlan(configDir);
  onMessage(existing ? "Logged out." : "Not logged in.");
}
