import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCodexBin } from "../../src/auth/codexBin";
import {
  parseModelList,
  refreshCodexSubscription,
  resetCodexModelCache,
} from "../../src/auth/codexRefresh";
import type { CodexJsonRpc } from "../../src/auth/codexAppServer";

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
  });
});
