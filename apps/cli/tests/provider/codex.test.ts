import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAuthedFetch, withCodexStoreOption } from "../../src/provider/codex";

describe("codexAuthedFetch", () => {
  let home: string;
  const original = process.env.CODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-fetch-"));
    process.env.CODEX_HOME = home;
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok-1", account_id: "acct-9" },
      }),
    );
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  test("attaches originator seri, account id, session_id, and forces store false", async () => {
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    const wrapped = codexAuthedFetch(
      home,
      "session-turn-1",
      (async (_url: string, init?: RequestInit) => {
        seen.push({
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: String(init?.body),
        });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    );
    await wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-terra", stream: true }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe("Bearer tok-1");
    expect(seen[0]?.headers.originator).toBe("seri");
    expect(seen[0]?.headers["chatgpt-account-id"]).toBe("acct-9");
    expect(seen[0]?.headers.session_id).toBe("session-turn-1");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      model: "gpt-5.6-terra",
      stream: true,
      store: false,
    });
  });

  test("throws when no chatgpt login is present", async () => {
    rmSync(join(home, "auth.json"));
    const wrapped = codexAuthedFetch(home, "s", (async () => new Response("ok")) as unknown as typeof fetch);
    await expect(wrapped("https://example.com")).rejects.toThrow(/No ChatGPT plan is connected/);
  });

  test("a 401 refreshes once via app-server and retries with the new token", async () => {
    const tokens: string[] = [];
    let status = 401;
    const wrapped = codexAuthedFetch(
      home,
      "s",
      (async (_url: string, init?: RequestInit) => {
        tokens.push(new Headers(init?.headers).get("authorization") ?? "");
        const response = new Response("{}", { status });
        status = 200;
        return response;
      }) as unknown as typeof fetch,
      async () => ({
        status: "ok" as const,
        credential: {
          provider: "openai" as const,
          accessToken: "tok-2",
          accountId: "acct-9",
          expiresAt: 0,
        },
      }),
    );
    const response = await wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-terra" }),
    });
    expect(response.status).toBe(200);
    expect(tokens).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  test("a body without stream still carries stream true and store false", async () => {
    let body = "";
    const wrapped = codexAuthedFetch(
      home,
      "s",
      (async (_url: string, init?: RequestInit) => {
        body = String(init?.body);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    );
    await wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-terra" }),
    });
    expect(JSON.parse(body)).toEqual({ model: "gpt-5.6-terra", store: false, stream: true });
  });
});

describe("withCodexStoreOption", () => {
  test("adds store false only for an openai subscription", () => {
    expect(withCodexStoreOption("openai", "subscription", { openai: { reasoningEffort: "low" } })).toEqual({
      openai: { reasoningEffort: "low", store: false },
    });
    expect(withCodexStoreOption("openai", "key", { openai: { reasoningEffort: "low" } })).toEqual({
      openai: { reasoningEffort: "low" },
    });
    expect(withCodexStoreOption("xai", "subscription", { openai: { reasoningEffort: "high" } })).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });
});
