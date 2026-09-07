import { describe, expect, test } from "bun:test";
import { pollForToken, requestDeviceCode } from "../../src/auth/deviceFlow";





describe.skipIf(!process.env.SERI_TEST_WORKOS_CLIENT_ID)(
  "requestDeviceCode + pollForToken (live WorkOS sandbox)",
  () => {
    test("requestDeviceCode returns a well-formed device authorization, and an immediate poll is pending", async () => {
      const clientId = process.env.SERI_TEST_WORKOS_CLIENT_ID as string;

      const device = await requestDeviceCode(clientId);

      expect(typeof device.deviceCode).toBe("string");
      expect(device.deviceCode.length).toBeGreaterThan(0);
      expect(typeof device.userCode).toBe("string");
      expect(device.userCode.length).toBeGreaterThan(0);
      expect(device.verificationUri.startsWith("https://")).toBe(true);
      expect(device.expiresIn).toBeGreaterThan(0);
      expect(device.interval).toBeGreaterThan(0);





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
  },
);
