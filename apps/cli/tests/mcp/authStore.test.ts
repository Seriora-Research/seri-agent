import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearMcpServerAuth,
  loadMcpServerAuth,
  mcpAuthPath,
  saveMcpServerAuth,
} from "../../src/mcp/authStore";

const URL_A = "https://mcp.exa.ai/mcp";
const URL_B = "https://mcp.evil.example/mcp";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function makeConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), "seri-mcp-auth-"));
  roots.push(root);
  const configDir = join(root, "profile");
  mkdirSync(configDir, { recursive: true });
  return configDir;
}

describe("round trip", () => {
  test("what was saved comes back for the same server and URL", () => {
    const configDir = makeConfigDir();
    saveMcpServerAuth(
      configDir,
      "exa",
      { tokens: { access_token: "at", token_type: "Bearer" } },
      URL_A,
    );

    const loaded = loadMcpServerAuth(configDir, "exa", URL_A);
    expect(loaded?.serverUrl).toBe(URL_A);
    expect(loaded?.tokens?.access_token).toBe("at");
    expect(typeof loaded?.obtainedAt).toBe("string");
  });

  test("nothing stored reads as undefined", () => {
    expect(loadMcpServerAuth(makeConfigDir(), "exa", URL_A)).toBeUndefined();
  });
});

describe("the patch merges rather than replaces", () => {
  // The order auth() (@ai-sdk/mcp) actually saves in: client information, then the authorization
  // server's metadata, then the tokens. A save that replaced instead of merging would leave the
  // last of the three alone on disk and force a full re-registration on the next run.
  test("three separate saves accumulate into one record", () => {
    const configDir = makeConfigDir();
    saveMcpServerAuth(configDir, "exa", { clientInformation: { client_id: "cid" } }, URL_A);
    saveMcpServerAuth(
      configDir,
      "exa",
      {
        authorizationServer: {
          authorizationServerUrl: "https://api.exa.ai",
          tokenEndpoint: "https://api.exa.ai/token",
        },
      },
      URL_A,
    );
    const merged = saveMcpServerAuth(
      configDir,
      "exa",
      { tokens: { access_token: "at", token_type: "Bearer" } },
      URL_A,
    );

    expect(merged.clientInformation?.client_id).toBe("cid");
    expect(merged.authorizationServer?.tokenEndpoint).toBe("https://api.exa.ai/token");
    expect(merged.tokens?.access_token).toBe("at");
    expect(loadMcpServerAuth(configDir, "exa", URL_A)).toEqual(merged);
  });

  test("clearing the tokens keeps the registered client", () => {
    const configDir = makeConfigDir();
    saveMcpServerAuth(
      configDir,
      "exa",
      { clientInformation: { client_id: "cid" }, tokens: { access_token: "at", token_type: "B" } },
      URL_A,
    );
    saveMcpServerAuth(configDir, "exa", { tokens: undefined }, URL_A);

    const loaded = loadMcpServerAuth(configDir, "exa", URL_A);
    expect(loaded?.tokens).toBeUndefined();
    expect(loaded?.clientInformation?.client_id).toBe("cid");
  });
});

describe("the stored URL gates the record", () => {
  test("a name repointed at a different host reads as no credentials", () => {
    const configDir = makeConfigDir();
    saveMcpServerAuth(
      configDir,
      "exa",
      { tokens: { access_token: "at", token_type: "Bearer" } },
      URL_A,
    );

    expect(loadMcpServerAuth(configDir, "exa", URL_B)).toBeUndefined();
  });

  test("saving under the new host replaces the old record rather than merging into it", () => {
    const configDir = makeConfigDir();
    saveMcpServerAuth(
      configDir,
      "exa",
      { clientInformation: { client_id: "cid" }, tokens: { access_token: "at", token_type: "B" } },
      URL_A,
    );
    const merged = saveMcpServerAuth(
      configDir,
      "exa",
      { clientInformation: { client_id: "new" } },
      URL_B,
    );

    expect(merged.serverUrl).toBe(URL_B);
    expect(merged.tokens).toBeUndefined();
    expect(loadMcpServerAuth(configDir, "exa", URL_A)).toBeUndefined();
  });
});

describe("a malformed file degrades to undefined", () => {
  test("unparseable JSON", () => {
    const configDir = makeConfigDir();
    const path = mcpAuthPath(configDir, "exa");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");

    expect(loadMcpServerAuth(configDir, "exa", URL_A)).toBeUndefined();
  });

  test("valid JSON that is not an object", () => {
    const configDir = makeConfigDir();
    const path = mcpAuthPath(configDir, "exa");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '"a string"');

    expect(loadMcpServerAuth(configDir, "exa", URL_A)).toBeUndefined();
  });
});

describe("clearMcpServerAuth", () => {
  test("is idempotent — a second call on a server with nothing stored does not throw", () => {
    const configDir = makeConfigDir();
    saveMcpServerAuth(
      configDir,
      "exa",
      { tokens: { access_token: "at", token_type: "Bearer" } },
      URL_A,
    );

    clearMcpServerAuth(configDir, "exa");
    expect(loadMcpServerAuth(configDir, "exa", URL_A)).toBeUndefined();
    expect(() => clearMcpServerAuth(configDir, "exa")).not.toThrow();
  });
});
