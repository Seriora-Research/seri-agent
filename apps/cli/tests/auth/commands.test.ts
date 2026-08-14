import { describe, expect, test } from "bun:test";
import { login } from "../../src/auth/commands";
import type { DeviceAuthorization, TokenResult } from "../../src/auth/deviceFlow";

const device: DeviceAuthorization = {
  deviceCode: "dc-1",
  userCode: "ABCD-1234",
  verificationUri: "https://example.com/device",
  verificationUriComplete: "https://example.com/device?user_code=ABCD-1234",
  expiresIn: 300,
  interval: 5,
};

function deps(pollResult: TokenResult) {
  return {
    requestDeviceCode: async () => device,
    openBrowser: async () => {},
    pollForToken: async () => pollResult,
  };
}

describe("login", () => {
  test("throws 'Authorization was denied.' when pollForToken resolves denied", async () => {
    await expect(
      login("login", "client_123", "fake-config-dir", deps({ status: "denied" })),
    ).rejects.toThrow("Authorization was denied.");
  });

  test("throws the expiry message when pollForToken resolves expired", async () => {
    await expect(
      login("login", "client_123", "fake-config-dir", deps({ status: "expired" })),
    ).rejects.toThrow("The login request expired. Please try again.");
  });

  test("throws the underlying message when pollForToken resolves error", async () => {
    const message = "WorkOS returned an unexpected error during authentication: invalid_client";
    await expect(
      login("login", "client_123", "fake-config-dir", deps({ status: "error", message })),
    ).rejects.toThrow(message);
  });

  // Bug fix (thermo-nuclear, round 5): distinct from denied/expired/error above — an abort is a
  // deliberate cancellation (Escape on "starting"/"device", cli.ts's own AuthPanel), not a
  // failure, so it must resolve cleanly with no error message and no onMessage call (which would
  // otherwise read as a successful sign-in that never happened).
  test("resolves cleanly, without throwing or calling onMessage, when pollForToken resolves aborted", async () => {
    const messages: string[] = [];

    await expect(
      login("login", "client_123", "fake-config-dir", {
        ...deps({ status: "aborted" }),
        onMessage: (message) => messages.push(message),
      }),
    ).resolves.toBeUndefined();
    expect(messages).toEqual([]);
  });

  // Bug fix (code-review, round 6): the abort window this closes sits BEFORE pollForTokenFn ever
  // starts — requestDeviceCodeFn is still in flight when the signal flips, so by the time it
  // resolves the abort has already landed, before onDeviceCode or openBrowserFn ever fire. Without
  // this check, the browser still popped open for a login the user already cancelled during the
  // "starting" step.
  test("skips onDeviceCode, opening the browser, and polling when the signal is already aborted once requestDeviceCode resolves", async () => {
    const controller = new AbortController();
    const opened: string[] = [];
    const deviceCodeCalls: unknown[] = [];
    let pollForTokenCalls = 0;

    await expect(
      login("login", "client_123", "fake-config-dir", {
        requestDeviceCode: async () => {
          // The abort lands WHILE this "network call" is in flight — the exact race the fix
          // targets.
          controller.abort();
          return device;
        },
        openBrowser: (url) => {
          opened.push(url);
        },
        pollForToken: async () => {
          pollForTokenCalls += 1;
          return { status: "aborted" };
        },
        onDeviceCode: (d) => deviceCodeCalls.push(d),
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();

    expect(opened).toEqual([]);
    expect(deviceCodeCalls).toEqual([]);
    expect(pollForTokenCalls).toBe(0);
  });
});
