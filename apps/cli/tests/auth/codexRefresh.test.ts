import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexJsonRpc } from "../../src/auth/codexAppServer";
import { describeCodexSetupStatus, findCodexBin } from "../../src/auth/codexBin";
import {
  codexPlanType,
  listCodexModels,
  parseAccountRead,
  parseModelList,
  refreshCodexSubscription,
  resetCodexModelCache,
} from "../../src/auth/codexRefresh";

describe("findCodexBin", () => {
  test("SERI_CODEX_BIN wins over PATH", () => {
    expect(findCodexBin({ SERI_CODEX_BIN: "/opt/codex", PATH: "/nope" })).toBe("/opt/codex");
  });

  test("an empty override falls through to PATH", () => {
    expect(findCodexBin({ SERI_CODEX_BIN: "", PATH: "" })).toBeUndefined();
  });
});

describe("parseModelList", () => {
  test("reads data[].id and displayName", () => {
    expect(
      parseModelList({
        data: [
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            supportedReasoningEfforts: ["low", "high"],
          },
        ],
      }),
    ).toEqual([
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        supportedReasoningEfforts: ["low", "high"],
      },
    ]);
  });

  test("accepts models[] and a top-level array, and skips rows without an id", () => {
    expect(parseModelList({ models: [{ slug: "gpt-5.6-terra" }, { name: "nope" }] })).toEqual([
      { id: "gpt-5.6-terra", displayName: "gpt-5.6-terra", supportedReasoningEfforts: [] },
    ]);
    expect(parseModelList([{ id: "only" }])).toEqual([
      { id: "only", displayName: "only", supportedReasoningEfforts: [] },
    ]);
  });

  test("malformed payloads become an empty list", () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList("nope")).toEqual([]);
  });

  test("reads supportedReasoningEfforts[].reasoningEffort", () => {
    expect(
      parseModelList({
        data: [
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          },
        ],
      }),
    ).toEqual([
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        supportedReasoningEfforts: ["low", "high"],
      },
    ]);
  });
});

describe("refreshCodexSubscription", () => {
  const originalHome = process.env.CODEX_HOME;
  let home: string;

  afterEach(() => {
    resetCodexModelCache();
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  test("without a chatgpt login it reports not-connected and never calls rpc", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-refresh-"));
    process.env.CODEX_HOME = home;
    let called = 0;
    const rpc: CodexJsonRpc = {
      request: async () => {
        called++;
        return {};
      },
      notify: () => {},
      close: () => {},
    };
    const result = await refreshCodexSubscription(home, { rpc, env: { CODEX_HOME: home } });
    expect(result.status).toBe("not-connected");
    expect(called).toBe(0);
  });

  test("account/read refreshToken true then re-reads the store", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-refresh-"));
    process.env.CODEX_HOME = home;
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "old", account_id: "acct-1" },
      }),
    );
    const methods: string[] = [];
    const rpc: CodexJsonRpc = {
      request: async (method, params) => {
        methods.push(method);
        expect(params).toEqual({ refreshToken: true });
        writeFileSync(
          join(home, "auth.json"),
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: { access_token: "new", account_id: "acct-1" },
          }),
        );
        return { account: { type: "chatgpt", planType: "plus" } };
      },
      notify: () => {},
      close: () => {},
    };
    const result = await refreshCodexSubscription(home, { rpc, env: { CODEX_HOME: home } });
    expect(result).toEqual({
      status: "ok",
      credential: { provider: "openai", accessToken: "new", accountId: "acct-1", expiresAt: 0 },
    });
    expect(methods).toEqual(["account/read"]);
    expect(codexPlanType()).toBe("plus");
  });
});

describe("parseAccountRead", () => {
  test("reads nested account.planType and a flat planType", () => {
    expect(parseAccountRead({ account: { type: "chatgpt", planType: "plus" } })).toEqual({
      planType: "plus",
    });
    expect(parseAccountRead({ type: "chatgpt", planType: "free" })).toEqual({ planType: "free" });
  });

  test("malformed payloads yield no planType", () => {
    expect(parseAccountRead(null)).toEqual({ planType: undefined });
    expect(parseAccountRead({ account: "nope" })).toEqual({ planType: undefined });
    expect(parseAccountRead({ planType: "" })).toEqual({ planType: undefined });
  });
});

describe("describeCodexSetupStatus", () => {
  test("connected without planType keeps the original copy", () => {
    expect(describeCodexSetupStatus({ status: "connected" })).toBe("ChatGPT plan connected");
  });

  test("connected with planType names the tier", () => {
    expect(describeCodexSetupStatus({ status: "connected", planType: "free" })).toBe(
      "ChatGPT free plan connected",
    );
    expect(describeCodexSetupStatus({ status: "connected", planType: "pro" })).toBe(
      "ChatGPT pro plan connected",
    );
  });

  test("ignored is local-only copy, not connected", () => {
    expect(describeCodexSetupStatus({ status: "ignored" })).toBe("ChatGPT plan ignored");
  });
});

describe("listCodexModels", () => {
  const originalHome = process.env.CODEX_HOME;
  let home: string;

  afterEach(() => {
    resetCodexModelCache();
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  test("reads model/list then account/read for planType", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-list-"));
    process.env.CODEX_HOME = home;
    const methods: string[] = [];
    const rpc: CodexJsonRpc = {
      request: async (method) => {
        methods.push(method);
        if (method === "model/list") {
          return { data: [{ id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" }] };
        }
        return { type: "chatgpt", planType: "free" };
      },
      notify: () => {},
      close: () => {},
    };
    const listed = await listCodexModels({ rpc, env: { CODEX_HOME: home } });
    expect(listed.map((m) => m.id)).toEqual(["gpt-5.6-terra"]);
    expect(methods).toEqual(["model/list", "account/read"]);
    expect(codexPlanType()).toBe("free");
  });

  test("follows nextCursor until the last page", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-list-"));
    process.env.CODEX_HOME = home;
    const calls: unknown[] = [];
    const rpc: CodexJsonRpc = {
      request: async (method, params) => {
        if (method === "model/list") {
          calls.push(params);
          if (calls.length === 1) {
            return { data: [{ id: "a", displayName: "A" }], nextCursor: "p2" };
          }
          return { data: [{ id: "b", displayName: "B" }] };
        }
        return {};
      },
      notify: () => {},
      close: () => {},
    };
    const listed = await listCodexModels({ rpc, env: { CODEX_HOME: home } });
    expect(listed.map((m) => m.id)).toEqual(["a", "b"]);
    expect(calls).toEqual([{ limit: 100 }, { limit: 100, cursor: "p2" }]);
  });

  test("an empty model/list is not cached so the next call retries", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-list-"));
    process.env.CODEX_HOME = home;
    let n = 0;
    const rpc: CodexJsonRpc = {
      request: async (method) => {
        if (method === "model/list") {
          n++;
          return { data: [] };
        }
        return {};
      },
      notify: () => {},
      close: () => {},
    };
    expect(await listCodexModels({ rpc, env: { CODEX_HOME: home } })).toEqual([]);
    expect(await listCodexModels({ rpc, env: { CODEX_HOME: home } })).toEqual([]);
    expect(n).toBe(2);
  });
});
