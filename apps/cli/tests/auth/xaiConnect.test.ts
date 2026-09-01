import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasXaiSubscription,
  loadXaiSubscription,
  saveXaiSubscription,
} from "../../src/auth/xaiAuthStore";
import {
  connectGrok,
  disconnectGrok,
  GROK_BORROWED_CLIENT_WARNING,
} from "../../src/auth/xaiConnect";
import type { XaiEndpoints } from "../../src/auth/xaiOAuth";

const ENDPOINTS: XaiEndpoints = {
  deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/code",
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
  userinfoEndpoint: "https://auth.x.ai/oauth2/userinfo",
};

const DEVICE = {
  deviceCode: "device-abc",
  userCode: "69GR-4SVP",
  verificationUri: "https://accounts.x.ai/oauth2/device",
  verificationUriComplete: "https://accounts.x.ai/oauth2/device?user_code=69GR-4SVP",
  expiresIn: 1800,
  interval: 5,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seri-xai-connect-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GROK_BORROWED_CLIENT_WARNING", () => {
  test("names Grok Build and that seri does not own the client id", () => {
    expect(GROK_BORROWED_CLIENT_WARNING).toContain("Grok Build");
    expect(GROK_BORROWED_CLIENT_WARNING).toContain("does not own");
  });
});

describe("connectGrok", () => {
  test("opens the browser only after the device code is issued, then stores userinfo sub", async () => {
    const events: string[] = [];
    await connectGrok(dir, {
      discover: async () => {
        events.push("discover");
        return ENDPOINTS;
      },
      requestDeviceCode: async () => {
        events.push("device");
        return DEVICE;
      },
      openBrowser: (url) => {
        events.push(`browser:${url}`);
      },
      pollForToken: async () => {
        events.push("poll");
        return {
          status: "success",
          value: { accessToken: "a", refreshToken: "r", expiresIn: 21600 },
        };
      },
      fetchAccountId: async () => {
        events.push("userinfo");
        return "acct-7";
      },
      onDeviceCode: () => {
        events.push("onDevice");
      },
      onMessage: () => {},
    });

    expect(events.indexOf("device")).toBeGreaterThanOrEqual(0);
    expect(
      events.indexOf("browser:https://accounts.x.ai/oauth2/device?user_code=69GR-4SVP"),
    ).toBeGreaterThan(events.indexOf("device"));
    expect(loadXaiSubscription(dir)?.accountId).toBe("acct-7");
    expect(loadXaiSubscription(dir)?.accessToken).toBe("a");
  });

  test("does not open the browser when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let opened = false;
    await connectGrok(dir, {
      discover: async () => ENDPOINTS,
      requestDeviceCode: async () => DEVICE,
      openBrowser: () => {
        opened = true;
      },
      pollForToken: async () => {
        throw new Error("poll must not run");
      },
      signal: controller.signal,
    });
    expect(opened).toBe(false);
    expect(hasXaiSubscription(dir)).toBe(false);
  });
});

describe("disconnectGrok", () => {
  test("clears the local file and says xAI access was not revoked", () => {
    const messages: string[] = [];
    // connectGrok's success path already covered persistence; seed via that store.
    saveXaiSubscription(
      { accessToken: "a", refreshToken: "r", obtainedAt: new Date().toISOString() },
      dir,
    );
    disconnectGrok(dir, (message) => messages.push(message));
    expect(hasXaiSubscription(dir)).toBe(false);
    expect(messages[0]).toContain("was not revoked");
  });
});
