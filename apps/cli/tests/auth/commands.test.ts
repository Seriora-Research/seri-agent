import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthSession } from "../../src/auth/authStore";
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
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-login-test-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });



  test("saves a session with expiresAt absent when pollForToken resolves success without expiresIn", async () => {
    await login("login", "client_123", configDir, {
      ...deps({
        status: "success",
        accessToken: "at-1",
        refreshToken: "rt-1",
        user: { id: "user_1", email: "a@example.com" },
      }),
    });

    const session = loadAuthSession(configDir);
    expect(session?.accessToken).toBe("at-1");
    expect(session?.refreshToken).toBe("rt-1");
    expect(session?.expiresAt).toBeUndefined();
  });

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






  test("skips onDeviceCode, opening the browser, and polling when the signal is already aborted once requestDeviceCode resolves", async () => {
    const controller = new AbortController();
    const opened: string[] = [];
    const deviceCodeCalls: unknown[] = [];
    let pollForTokenCalls = 0;

    await expect(
      login("login", "client_123", "fake-config-dir", {
        requestDeviceCode: async () => {


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
