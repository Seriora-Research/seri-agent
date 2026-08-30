import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthClientProvider } from "@ai-sdk/mcp";
import {
  createMcpAuthProvider,
  MCP_CALLBACK_PORTS,
  type McpAuthInteraction,
  McpLoginRequiredError,
  mcpCallbackUri,
} from "../../src/mcp/authProvider";
import { mcpAuthPath, saveMcpServerAuth } from "../../src/mcp/authStore";

const SERVER_URL = "https://mcp.exa.ai/mcp";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function makeConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), "seri-mcp-provider-"));
  roots.push(root);
  const configDir = join(root, "profile");
  mkdirSync(configDir, { recursive: true });
  return configDir;
}

function provider(configDir: string, interaction: McpAuthInteraction): OAuthClientProvider {
  return createMcpAuthProvider({
    spec: { name: "exa", url: SERVER_URL },
    configDir,
    interaction,
  });
}

const REFUSE: McpAuthInteraction = { kind: "refuse" };

function redirect(onRedirect: (url: URL) => void): McpAuthInteraction {
  return { kind: "redirect", redirectUri: mcpCallbackUri(41999), onRedirect };
}

// Called through a narrowed local rather than `provider.validateAuthorizationServerURL?.(…)`: the
// optional call would make every "does not throw" assertion below pass vacuously if the provider
// ever stopped implementing the hook, which is the one thing the refuse persona depends on.
function validateAs(p: OAuthClientProvider, authorizationServerUrl: string): void {
  const validate = p.validateAuthorizationServerURL;
  if (validate === undefined) throw new Error("the provider must implement it");
  validate(SERVER_URL, authorizationServerUrl);
}

describe("the refuse persona never starts a login", () => {
  test("an empty store throws McpLoginRequiredError before dynamic registration could run", () => {
    const configDir = makeConfigDir();
    expect(() => validateAs(provider(configDir, REFUSE), "https://api.exa.ai")).toThrow(
      McpLoginRequiredError,
    );
  });

  // Both halves, not either: a record with a registered client but no tokens has nothing to spend
  // and nothing to refresh, so letting it through would reach redirectToAuthorization anyway.
  test("a registered client with no tokens still refuses", () => {
    const configDir = makeConfigDir();
    saveMcpServerAuth(configDir, "exa", { clientInformation: { client_id: "cid" } }, SERVER_URL);
    expect(() => validateAs(provider(configDir, REFUSE), "https://api.exa.ai")).toThrow(
      McpLoginRequiredError,
    );
  });

  test("tokens and client information together pass, so a refresh can proceed", () => {
    const configDir = makeConfigDir();
    saveMcpServerAuth(
      configDir,
      "exa",
      {
        clientInformation: { client_id: "cid" },
        tokens: { access_token: "at", token_type: "Bearer", refresh_token: "rt" },
      },
      SERVER_URL,
    );
    expect(() => validateAs(provider(configDir, REFUSE), "https://api.exa.ai")).not.toThrow();
  });

  test("redirectToAuthorization throws even once tokens exist, for the failed-refresh path", () => {
    const configDir = makeConfigDir();
    expect(() =>
      provider(configDir, REFUSE).redirectToAuthorization(new URL("https://api.exa.ai/authorize")),
    ).toThrow(McpLoginRequiredError);
  });
});

describe("a non-https authorization server is refused in both personae", () => {
  test("refuse", () => {
    const configDir = makeConfigDir();
    saveMcpServerAuth(
      configDir,
      "exa",
      { clientInformation: { client_id: "cid" }, tokens: { access_token: "at", token_type: "B" } },
      SERVER_URL,
    );
    expect(() => validateAs(provider(configDir, REFUSE), "http://api.exa.ai")).toThrow(/non-https/);
  });

  test("redirect", () => {
    const configDir = makeConfigDir();
    expect(() =>
      validateAs(
        provider(
          configDir,
          redirect(() => {}),
        ),
        "http://api.exa.ai",
      ),
    ).toThrow(/non-https/);
  });
});

describe("the redirect persona hands the authorize URL to its callback", () => {
  test("onRedirect receives it and nothing is thrown", () => {
    const configDir = makeConfigDir();
    let seen: URL | undefined;
    const url = new URL("https://api.exa.ai/authorize?state=abc");
    provider(
      configDir,
      redirect((u) => {
        seen = u;
      }),
    ).redirectToAuthorization(url);
    expect(seen?.href).toBe(url.href);
  });
});

describe("the PKCE verifier and the CSRF state stay in memory", () => {
  test("neither reaches the record a token save writes", () => {
    const configDir = makeConfigDir();
    const p = provider(
      configDir,
      redirect(() => {}),
    );
    p.saveCodeVerifier("verifier-value-that-must-not-be-written");
    const state = p.state?.();
    expect(typeof state).toBe("string");
    p.saveTokens({ access_token: "at", token_type: "Bearer" });

    const written = readFileSync(mcpAuthPath(configDir, "exa"), "utf8");
    expect(written).toContain("at");
    expect(written).not.toContain("verifier-value-that-must-not-be-written");
    expect(written).not.toContain(state as string);
  });

  test("a second provider for the same server sees neither", () => {
    const configDir = makeConfigDir();
    const first = provider(
      configDir,
      redirect(() => {}),
    );
    first.saveCodeVerifier("v1");
    const firstState = first.state?.();

    const second = provider(
      configDir,
      redirect(() => {}),
    );
    expect(second.storedState?.()).toBeUndefined();
    expect(() => second.codeVerifier()).toThrow(/never started/);
    expect(second.state?.()).not.toBe(firstState);
  });
});

describe("clientMetadata", () => {
  test("registers every candidate port at once and names no auth method or scope", () => {
    const metadata = provider(makeConfigDir(), REFUSE).clientMetadata;
    expect(metadata.redirect_uris).toEqual(MCP_CALLBACK_PORTS.map(mcpCallbackUri));
    expect(metadata.redirect_uris).toHaveLength(4);
    expect(metadata.token_endpoint_auth_method).toBeUndefined();
    expect(metadata.scope).toBeUndefined();
  });
});
