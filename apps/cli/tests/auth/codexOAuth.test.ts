import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexAuthorizeUrl,
  CODEX_CLIENT_ID_DEFAULT,
  CODEX_ORIGINATOR,
  CODEX_SCOPE,
  codexClientId,
  extractCodexAccountId,
  pkceChallenge,
  readCodexRefreshTokens,
  readCodexTokens,
  refreshCodexGrant,
} from "../../src/auth/codexOAuth";

function withTempConfig<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "seri-codex-oauth-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jwtWithAccount(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      exp: 1_700_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `aaa.${payload}.sig`;
}

describe("client id configuration", () => {
  test("the default is Codex CLI's borrowed client id", () => {
    withTempConfig((dir) => {
      expect(codexClientId(dir)).toBe(CODEX_CLIENT_ID_DEFAULT);
      expect(CODEX_CLIENT_ID_DEFAULT).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    });
  });

  test("SERI_CODEX_CLIENT_ID overrides the default", () => {
    withTempConfig((dir) => {
      process.env.SERI_CODEX_CLIENT_ID = "custom-id";
      try {
        expect(codexClientId(dir)).toBe("custom-id");
      } finally {
        delete process.env.SERI_CODEX_CLIENT_ID;
      }
    });
  });
});

describe("buildCodexAuthorizeUrl", () => {
  test("originator is seri and never Codex CLI's originator", () => {
    const url = buildCodexAuthorizeUrl({
      issuer: "https://auth.openai.com",
      clientId: CODEX_CLIENT_ID_DEFAULT,
      redirectUri: "http://localhost:1455/auth/callback",
      codeChallenge: "challenge",
      state: "state-1",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(parsed.searchParams.get("originator")).toBe(CODEX_ORIGINATOR);
    expect(parsed.searchParams.get("originator")).toBe("seri");
    expect(url).not.toContain("codex_cli_rs");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("scope")).toBe(CODEX_SCOPE);
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
  });
});

describe("PKCE", () => {
  test("challenge is S256 of the verifier", () => {
    const verifier = "abc";
    const expected = require("node:crypto")
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    expect(pkceChallenge(verifier)).toBe(expected);
  });
});

describe("token readers", () => {
  test("readCodexTokens requires both tokens", () => {
    expect(() => readCodexTokens({ access_token: "a" })).toThrow(/refresh_token/);
    expect(readCodexTokens({ access_token: "a", refresh_token: "r", expires_in: 9 })).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresIn: 9,
    });
  });

  test("readCodexRefreshTokens keeps the previous refresh token when none rotates", () => {
    expect(readCodexRefreshTokens({ access_token: "a" }, "prev")).toEqual({
      accessToken: "a",
      refreshToken: "prev",
      expiresIn: undefined,
    });
  });
});

describe("extractCodexAccountId", () => {
  test("reads chatgpt_account_id from the OpenAI auth claim", () => {
    expect(extractCodexAccountId(jwtWithAccount("acct-fx"))).toBe("acct-fx");
  });

  test("rejects a token without the claim", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url");
    expect(() => extractCodexAccountId(`aaa.${payload}.sig`)).toThrow(/auth claim/);
  });
});

describe("refreshCodexGrant", () => {
  test("posts JSON and maps invalid_grant to reconnect-required", async () => {
    await expect(
      refreshCodexGrant(
        {
          tokenUrl: "https://auth.openai.com/oauth/token",
          clientId: "id",
          refreshToken: "dead",
        },
        (async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
          })) as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ name: "CodexReconnectRequired" });
  });
});
