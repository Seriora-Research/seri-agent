import { clearAuthSession, expiresAtFrom, loadAuthSession, saveAuthSession } from "./authStore";
import { openBrowser } from "./browser";
import { pollForToken, requestDeviceCode } from "./deviceFlow";

export async function login(
  mode: "login" | "signup",
  clientId: string,
  configDir: string,
  deps: {
    requestDeviceCode?: typeof requestDeviceCode;
    openBrowser?: typeof openBrowser;
    pollForToken?: typeof pollForToken;
    // The TUI's own presentation seam (Stage C, cli-commands-to-tui feature-plan.md): the two
    // callbacks below let the TUI dispatch into its reducer instead of this function printing
    // straight into Ink's own frame with a bare console.log, which the non-interactive CLI path
    // still gets by default (`?? console.log`) — the same decision/presentation split every
    // tui/commands.ts `decide*` function already has, just inlined here since login/logout are
    // the only two auth entry points, and the console.log defaults ARE the console presentation.
    onDeviceCode?: (device: { verificationUri: string; userCode: string }) => void;
    onMessage?: (message: string) => void;
    // Bug fix (thermo-nuclear, round 5): threaded straight through to pollForTokenFn — the TUI's
    // own createAuthHandlers (tui/handlers.ts) passes one per attempt so abandoning
    // "starting"/"device" (Escape) actually stops the poll, instead of merely muting its eventual
    // dispatches while it keeps running in the background and could still call saveAuthSession later.
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

  // Bug fix (code-review, round 6): an abort landing during the "starting" step — before the
  // device code even arrives — used to fall through both checks below unnoticed (pollForTokenFn's
  // own `{status:"aborted"}` only fires once IT starts, which is after this point) and still pop
  // the browser open for a login the user already cancelled. Same early-return shape as the
  // `"aborted"` branch after pollForTokenFn, just reached before ever opening the browser or
  // starting the poll.
  if (deps.signal?.aborted === true) {
    return;
  }

  onDeviceCode({ verificationUri: device.verificationUri, userCode: device.userCode });
  openBrowserFn(device.verificationUriComplete);

  const result = await pollForTokenFn(clientId, device, { signal: deps.signal });

  // An abort is an intentional cancellation, not a failure — no error message, no session write,
  // just a plain return (the caller already knows it abandoned this attempt).
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
  onMessage(existing ? "Logged out." : "Not logged in.");
}
