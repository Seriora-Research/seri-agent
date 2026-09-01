import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { saveXaiSubscription } from "../../src/auth/xaiAuthStore";
import {
  GROK_CLIENT_IDENTIFIER,
  GROK_PROXY_BASE_URL_DEFAULT,
  grokCatalogHeaders,
  grokSubscriptionHeaders,
  getXaiSubscriptionModel,
} from "../../src/provider/xai";

function asFetch(fn: (url: any, init?: any) => Promise<Response>): typeof fetch {
  return fn as unknown as typeof fetch;
}

describe("grokSubscriptionHeaders", () => {
  test("x-grok-client-identifier is the literal seri, not fx or Grok Build", () => {
    const headers = grokSubscriptionHeaders({ modelId: "grok-4", accountId: "acct", sessionId: "s1" });
    expect(headers["x-grok-client-identifier"]).toBe("seri");
    expect(GROK_CLIENT_IDENTIFIER).toBe("seri");
    expect(headers["x-grok-client-identifier"]).not.toBe("fx");
    expect(headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(headers["x-grok-user-id"]).toBe("acct");
    expect(headers["x-grok-conv-id"]).toBe("s1");
    expect(headers["x-grok-model-override"]).toBe("grok-4");
  });
});

describe("grokCatalogHeaders", () => {
  test("sends the protocol headers and x-userid", () => {
    const headers = grokCatalogHeaders("acct");
    expect(headers["x-grok-client-identifier"]).toBe("seri");
    expect(headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(headers["x-userid"]).toBe("acct");
  });
});

describe("getXaiSubscriptionModel", () => {
  test("POSTs to the Grok proxy Responses surface, not Chat Completions on api.x.ai", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-xai-sub-model-"));
    try {
      saveXaiSubscription(
        {
          accessToken: "access-1",
          refreshToken: "refresh-1",
          obtainedAt: new Date().toISOString(),
          accountId: "acct-1",
        },
        dir,
      );
      const urls: string[] = [];
      const identifiers: Array<string | null> = [];
      const fetchFn = asFetch(async (url, init) => {
        urls.push(String(url));
        identifiers.push(new Headers(init?.headers).get("x-grok-client-identifier"));
        return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
      });
      const model = getXaiSubscriptionModel("grok-4", dir, "sess-1", fetchFn);
      await generateText({ model, prompt: "hi", maxRetries: 0 }).catch(() => {});
      expect(urls.some((url) => url.includes(GROK_PROXY_BASE_URL_DEFAULT) && url.includes("/responses"))).toBe(
        true,
      );
      expect(urls.some((url) => url.includes("/chat/completions"))).toBe(false);
      expect(urls.some((url) => url.includes("api.x.ai"))).toBe(false);
      expect(identifiers).toContain("seri");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
