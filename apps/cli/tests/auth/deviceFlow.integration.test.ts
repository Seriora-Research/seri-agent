import { describe, expect, test } from "bun:test";
import { pollForToken, requestDeviceCode } from "../../src/auth/deviceFlow";

// Live test against the WorkOS Staging sandbox — silently skipped unless
// HESPER_TEST_WORKOS_CLIENT_ID is set (e.g. in a developer's own shell). Never hardcode
// the sandbox client id here; it's read from the env var only, so this is skipped
// everywhere that var isn't set (including CI, which has no WorkOS secret configured).
describe.skipIf(!process.env.HESPER_TEST_WORKOS_CLIENT_ID)("requestDeviceCode + pollForToken (live WorkOS sandbox)", () => {
  test("requestDeviceCode returns a well-formed device authorization, and an immediate poll is pending", async () => {
    const clientId = process.env.HESPER_TEST_WORKOS_CLIENT_ID as string;

    const device = await requestDeviceCode(clientId);

    expect(typeof device.deviceCode).toBe("string");
    expect(device.deviceCode.length).toBeGreaterThan(0);
    expect(typeof device.userCode).toBe("string");
    expect(device.userCode.length).toBeGreaterThan(0);
    expect(device.verificationUri.startsWith("https://")).toBe(true);
    expect(device.expiresIn).toBeGreaterThan(0);
    expect(device.interval).toBeGreaterThan(0);

    // A single real poll, immediately, with no human clicking through the browser: the
    // server must report authorization_pending, not a terminal state. `now()` forces the
    // client-side expiry backstop to trip right after that one poll, so this test issues
    // exactly one real request to WorkOS rather than looping until the device code expires.
    let sawPending = false;
    const nowValues = [0, 0, device.expiresIn * 1000 + 1];
    const result = await pollForToken(clientId, device, {
      now: () => nowValues.shift() ?? device.expiresIn * 1000 + 1,
      sleep: async () => {},
      fetchFn: (async (url: string, init: RequestInit) => {
        const response = await fetch(url, init);
        if (!response.ok) {
          const body = await response.clone().json();
          if (body.error === "authorization_pending") sawPending = true;
        }
        return response;
      }) as unknown as typeof fetch,
    });

    expect(sawPending).toBe(true);
    expect(result).toEqual({ status: "expired" });
  }, 15000);
});
