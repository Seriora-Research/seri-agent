import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexJsonRpc } from "../../src/auth/codexAppServer";
import { describeCodexSetupStatus, findCodexBin, resolveCodexSpawn } from "../../src/auth/codexBin";
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

describe("resolveCodexSpawn", () => {
  test("a Windows .cmd path is launched through cmd.exe /d /s /c", () => {
    const resolved = resolveCodexSpawn(
      String.raw`C:\Users\lioar\AppData\Local\pnpm\bin\codex.cmd`,
      ["app-server", "--stdio"],
      "win32",
    );
    expect(resolved.command).toBe("cmd.exe");
    expect(resolved.args).toEqual([
      "/d",
      "/s",
      "/c",
      String.raw`"C:\Users\lioar\AppData\Local\pnpm\bin\codex.cmd" app-server --stdio`,
    ]);
    expect(resolved.windowsVerbatimArguments).toBe(true);
  });

  test("a .bat path is rewritten the same way, and a quoted space in the path stays one argument", () => {
    const resolved = resolveCodexSpawn(
      String.raw`C:\Program Files\codex.bat`,
      ["app-server", "--stdio"],
      "win32",
    );
    expect(resolved.command).toBe("cmd.exe");
    expect(resolved.args[3]).toBe(String.raw`"C:\Program Files\codex.bat" app-server --stdio`);
  });

  test("a POSIX codex path is left as-is", () => {
    expect(resolveCodexSpawn("/usr/bin/codex", ["app-server", "--stdio"], "linux")).toEqual({
      command: "/usr/bin/codex",
      args: ["app-server", "--stdio"],
    });
  });

  test("a Windows .exe is spawned directly", () => {
    const resolved = resolveCodexSpawn(String.raw`C:\codex.exe`, ["app-server"], "win32");
    expect(resolved).toEqual({ command: String.raw`C:\codex.exe`, args: ["app-server"] });
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

  test("without a chatgpt login it reports not-connected and never fetches", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-refresh-"));
    process.env.CODEX_HOME = home;
    let called = 0;
    const result = await refreshCodexSubscription(home, {
      env: { CODEX_HOME: home },
      fetchFn: (async () => {
        called++;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result.status).toBe("not-connected");
    expect(called).toBe(0);
  });

  test("HTTP refresh persists the rotated pair to the seri file", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-refresh-"));
    process.env.CODEX_HOME = home;
    writeFileSync(
      join(home, "codex-auth.json"),
      JSON.stringify({
        accessToken: "old",
        refreshToken: "refresh-old",
        obtainedAt: "2026-01-01T00:00:00.000Z",
        accountId: "acct-1",
      }),
    );
    const result = await refreshCodexSubscription(home, {
      fetchFn: (async (_url: string, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          client_id: expect.any(String),
          grant_type: "refresh_token",
          refresh_token: "refresh-old",
        });
        return new Response(
          JSON.stringify({
            access_token: "new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.credential.accessToken).toBe("new");
      expect(result.credential.accountId).toBe("acct-1");
    }
    const stored = JSON.parse(readFileSync(join(home, "codex-auth.json"), "utf8"));
    expect(stored.accessToken).toBe("new");
    expect(stored.refreshToken).toBe("refresh-new");
  });

  test("a leftover Codex CLI login refreshes over HTTP into the seri file", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-refresh-"));
    process.env.CODEX_HOME = home;
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "old", refresh_token: "refresh-old", account_id: "acct-1" },
      }),
    );
    const leftoverBefore = readFileSync(join(home, "auth.json"), "utf8");
    const result = await refreshCodexSubscription(home, {
      env: { CODEX_HOME: home },
      fetchFn: (async () =>
        new Response(JSON.stringify({ access_token: "new", refresh_token: "refresh-new" }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    expect(result.status).toBe("ok");
    expect(JSON.parse(readFileSync(join(home, "codex-auth.json"), "utf8")).refreshToken).toBe(
      "refresh-new",
    );
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(leftoverBefore);
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
  test("connected without planType matches the grok/seri status word", () => {
    expect(describeCodexSetupStatus({ status: "connected" })).toBe("connected");
  });

  test("connected with planType names the tier", () => {
    expect(describeCodexSetupStatus({ status: "connected", planType: "free" })).toBe(
      "connected — free",
    );
    expect(describeCodexSetupStatus({ status: "connected", planType: "pro" })).toBe(
      "connected — pro",
    );
  });

  test("ignored is local-only copy, not connected", () => {
    expect(describeCodexSetupStatus({ status: "ignored" })).toBe("ignored");
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

  test("lists models over HTTP with no Codex CLI and no leftover ~/.codex", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "seri-codex-http-list-cfg-"));
    const leftover = mkdtempSync(join(tmpdir(), "seri-codex-http-list-home-"));
    writeFileSync(
      join(configDir, "codex-auth.json"),
      JSON.stringify({
        accessToken: "tok-plan",
        refreshToken: "refresh-plan",
        obtainedAt: new Date().toISOString(),
        accountId: "acct-plan",
      }),
    );
    const seen: Array<{ url: string; authorization?: string; originator?: string }> = [];
    try {
      const listed = await listCodexModels({
        configDir,
        env: { PATH: "", CODEX_HOME: leftover, HOME: leftover },
        fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          seen.push({
            url,
            authorization: headers.get("authorization") ?? undefined,
            originator: headers.get("originator") ?? undefined,
          });
          return new Response(
            JSON.stringify({
              data: [
                {
                  slug: "gpt-5.6-luna",
                  display_name: "GPT-5.6 Luna",
                  supported_reasoning_efforts: ["low", "high"],
                },
              ],
            }),
            { status: 200 },
          );
        }) as typeof fetch,
      });
      expect(listed).toEqual([
        {
          id: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          supportedReasoningEfforts: ["low", "high"],
        },
      ]);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe("https://chatgpt.com/backend-api/codex/models");
      expect(seen[0]?.authorization).toBe("Bearer tok-plan");
      expect(seen[0]?.originator).toBe("seri");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(leftover, { recursive: true, force: true });
    }
  });
});
