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
    await expect(login("login", "client_123", "fake-config-dir", deps({ status: "denied" }))).rejects.toThrow(
      "Authorization was denied.",
    );
  });

  test("throws the expiry message when pollForToken resolves expired", async () => {
    await expect(login("login", "client_123", "fake-config-dir", deps({ status: "expired" }))).rejects.toThrow(
      "The login request expired. Please try again.",
    );
  });

  test("throws the underlying message when pollForToken resolves error", async () => {
    const message = "WorkOS returned an unexpected error during authentication: invalid_client";
    await expect(login("login", "client_123", "fake-config-dir", deps({ status: "error", message }))).rejects.toThrow(
      message,
    );
  });
});
