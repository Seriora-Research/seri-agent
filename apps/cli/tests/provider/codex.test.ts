import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamText } from "ai";
import { compactMessages } from "../../src/loop/compaction";
import { codexAuthedFetch, getCodexSubscriptionModel } from "../../src/provider/codex";

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

  test("attaches originator seri, account id, and session_id without rewriting the body", async () => {
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    const wrapped = codexAuthedFetch(home, "session-turn-1", (async (
      _url: string,
      init?: RequestInit,
    ) => {
      seen.push({
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: String(init?.body),
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    const payload = { model: "gpt-5.6-terra", stream: true };
    await wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe("Bearer tok-1");
    expect(seen[0]?.headers.originator).toBe("seri");
    expect(seen[0]?.headers["chatgpt-account-id"]).toBe("acct-9");
    expect(seen[0]?.headers.session_id).toBe("session-turn-1");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual(payload);
  });

  test("throws when no chatgpt login is present", async () => {
    rmSync(join(home, "auth.json"));
    const wrapped = codexAuthedFetch(
      home,
      "s",
      (async () => new Response("ok")) as unknown as typeof fetch,
    );
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

  test("leaves a body without stream or store untouched", async () => {
    let body = "";
    const wrapped = codexAuthedFetch(home, "s", (async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    const payload = { model: "gpt-5.6-terra" };
    await wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(JSON.parse(body)).toEqual(payload);
  });
});

describe("getCodexSubscriptionModel", () => {
  let home: string;
  const original = process.env.CODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-model-"));
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

  async function captureBody(
    extra?: Parameters<typeof streamText>[0]["providerOptions"],
  ): Promise<Record<string, unknown>> {
    let body = "";
    const model = getCodexSubscriptionModel("gpt-5.6-terra", home, "s", (async (
      _url: string,
      init?: RequestInit,
    ) => {
      body = String(init?.body);
      return new Response("nope", { status: 400 });
    }) as unknown as typeof fetch);
    try {
      await streamText({
        model,
        messages: [{ role: "user", content: "hi" }],
        maxRetries: 0,
        onError: () => {},
        ...(extra ? { providerOptions: extra } : {}),
      }).text;
    } catch {}
    return JSON.parse(body) as Record<string, unknown>;
  }

  test("streamText sends store false and stream true without a fetch rewrite", async () => {
    const payload = await captureBody();
    expect(payload.store).toBe(false);
    expect(payload.stream).toBe(true);
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("keeps caller openai providerOptions next to store false", async () => {
    const payload = await captureBody({ openai: { reasoningEffort: "low" } });
    expect(payload.store).toBe(false);
    expect(payload.reasoning).toMatchObject({ effort: "low" });
  });

  test("a caller store true still goes out as store false", async () => {
    const payload = await captureBody({ openai: { store: true } });
    expect(payload.store).toBe(false);
  });

  test("compactMessages streamText still sends store false without a fetch rewrite", async () => {
    let body = "";
    const model = getCodexSubscriptionModel("gpt-5.6-terra", home, "s", (async (
      _url: string,
      init?: RequestInit,
    ) => {
      body = String(init?.body);
      return new Response("nope", { status: 400 });
    }) as unknown as typeof fetch);
    await expect(
      compactMessages(
        [
          { role: "user", content: "do the task" },
          { role: "assistant", content: "working" },
          { role: "user", content: "status" },
          { role: "user", content: "keep me, recent tail" },
        ],
        model,
        3,
        undefined,
        { stream: true },
      ),
    ).rejects.toBeDefined();
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload.store).toBe(false);
    expect(payload.stream).toBe(true);
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
  });
});
