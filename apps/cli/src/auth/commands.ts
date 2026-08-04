import { clearAuthSession, loadAuthSession, saveAuthSession } from "./authStore";
import { openBrowser } from "./browser";
import { pollForToken, requestDeviceCode } from "./deviceFlow";

export async function login(
  mode: "login" | "signup",
  clientId: string,
  configDir: string,
  deps: { requestDeviceCode?: typeof requestDeviceCode; openBrowser?: typeof openBrowser; pollForToken?: typeof pollForToken } = {},
): Promise<void> {
  const requestDeviceCodeFn = deps.requestDeviceCode ?? requestDeviceCode;
  const openBrowserFn = deps.openBrowser ?? openBrowser;
  const pollForTokenFn = deps.pollForToken ?? pollForToken;

  const device = await requestDeviceCodeFn(clientId);

  console.log(`To continue, open: ${device.verificationUri}`);
  console.log(`And enter code: ${device.userCode}`);
  openBrowserFn(device.verificationUriComplete);

  const result = await pollForTokenFn(clientId, device);

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
    },
    configDir,
  );

  console.log(mode === "signup" ? `Account created — logged in as ${result.user.email}` : `Logged in as ${result.user.email}`);
}

export function logout(configDir: string): void {
  const existing = loadAuthSession(configDir);
  clearAuthSession(configDir);
  console.log(existing ? "Logged out." : "Not logged in.");
}
