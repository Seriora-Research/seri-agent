// Every listener and every auth() here is a fake: no socket is opened, no browser is launched and
// nothing contacts a network, the same rule tests/mcp/client.test.ts states for its own dials.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { auth } from "@ai-sdk/mcp";
import { mcpCallbackUri } from "../../src/mcp/authProvider";
import { loginMcpServer } from "../../src/mcp/login";
import type { CallbackServer, McpCallbackWait, StartCallbackServer } from "../../src/mcp/loopback";
import type { McpServerSpec } from "../../src/mcp/types";

type AuthOptions = Parameters<typeof auth>[1];
type WaitOptions = Parameters<CallbackServer["waitForCallback"]>[0];

const SPEC: McpServerSpec = {
  name: "exa",
  url: "https://mcp.exa.ai/mcp",
  headers: {},
  source: "user",
  filePath: "servers.yaml",
};

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function makeConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), "seri-mcp-login-"));
  roots.push(root);
  const configDir = join(root, "profile");
  mkdirSync(configDir, { recursive: true });
  return configDir;
}

function fakeListen(result: McpCallbackWait): {
  listen: StartCallbackServer;
  closes: number[];
  waits: WaitOptions[];
} {
  const closes: number[] = [];
  const waits: WaitOptions[] = [];
  const server: CallbackServer = {
    redirectUri: mcpCallbackUri(41999),
    waitForCallback: async (opts) => {
      waits.push(opts);
      return result;
    },
    close: () => {
      closes.push(closes.length);
    },
  };
  return { listen: async () => server, closes, waits };
}

// Returns the given AuthResult for each successive call, recording the options it was handed.
function fakeAuth(results: readonly ("AUTHORIZED" | "REDIRECT")[]): {
  authFn: typeof auth;
  calls: AuthOptions[];
} {
  const calls: AuthOptions[] = [];
  const authFn: typeof auth = async (_provider, options) => {
    calls.push(options);
    return results[calls.length - 1] ?? "REDIRECT";
  };
  return { authFn, calls };
}

describe("a stored refresh token skips the browser", () => {
  test("the first auth() returning AUTHORIZED succeeds without ever waiting", async () => {
    const { listen, closes, waits } = fakeListen({ kind: "timeout" });
    const result = await loginMcpServer(SPEC, makeConfigDir(), {
      listen,
      authFn: fakeAuth(["AUTHORIZED"]).authFn,
      openUrl: () => {},
    });

    expect(result).toEqual({ status: "success" });
    expect(waits).toHaveLength(0);
    expect(closes).toHaveLength(1);
  });
});

describe("the two-phase path", () => {
  test("the redirect is printed and opened, then the code is exchanged", async () => {
    const authorizeUrl = new URL("https://api.exa.ai/authorize?client_id=cid");
    const { listen, closes, waits } = fakeListen({
      kind: "code",
      code: "the-code",
      state: "the-state",
      iss: "https://api.exa.ai",
    });
    // Mirrors auth()'s own order: it mints the state, then redirects, then returns REDIRECT.
    const calls: AuthOptions[] = [];
    let mintedState: string | undefined;
    const authFn: typeof auth = async (provider, options) => {
      calls.push(options);
      if (calls.length > 1) return "AUTHORIZED";
      mintedState = await provider.state?.();
      await provider.redirectToAuthorization(authorizeUrl);
      return "REDIRECT";
    };

    const lines: string[] = [];
    const opened: string[] = [];
    const result = await loginMcpServer(SPEC, makeConfigDir(), {
      listen,
      authFn,
      onMessage: (line) => lines.push(line),
      openUrl: (url) => opened.push(url),
    });

    expect(result).toEqual({ status: "success" });
    expect(opened).toEqual([authorizeUrl.href]);
    expect(lines.some((line) => line.includes(authorizeUrl.href))).toBe(true);
    // The state the callback is checked against is the one auth() minted, not a fresh value.
    expect(waits[0]?.expectedState).toBe(mintedState as string);
    expect(calls[1]).toMatchObject({
      authorizationCode: "the-code",
      callbackState: "the-state",
      callbackIssuer: "https://api.exa.ai",
    });
    expect(closes).toHaveLength(1);
  });
});

describe("every other ending maps to its own status, and closes the listener", () => {
  test("denied carries the authorization server's own description", async () => {
    const { listen, closes } = fakeListen({ kind: "denied", message: "User declined" });
    const result = await loginMcpServer(SPEC, makeConfigDir(), {
      listen,
      authFn: fakeAuth(["REDIRECT"]).authFn,
      openUrl: () => {},
    });

    expect(result).toEqual({ status: "denied", message: "User declined" });
    expect(closes).toHaveLength(1);
  });

  test("timeout", async () => {
    const { listen, closes } = fakeListen({ kind: "timeout" });
    const result = await loginMcpServer(SPEC, makeConfigDir(), {
      listen,
      authFn: fakeAuth(["REDIRECT"]).authFn,
      openUrl: () => {},
    });

    expect(result).toEqual({ status: "timeout" });
    expect(closes).toHaveLength(1);
  });

  test("aborted", async () => {
    const { listen, closes } = fakeListen({ kind: "aborted" });
    const result = await loginMcpServer(SPEC, makeConfigDir(), {
      listen,
      authFn: fakeAuth(["REDIRECT"]).authFn,
      openUrl: () => {},
    });

    expect(result).toEqual({ status: "aborted" });
    expect(closes).toHaveLength(1);
  });

  test("a thrown auth() becomes an error result rather than a rejection", async () => {
    const { listen, closes } = fakeListen({ kind: "timeout" });
    const authFn: typeof auth = async () => {
      throw new Error("registration refused");
    };

    const result = await loginMcpServer(SPEC, makeConfigDir(), {
      listen,
      authFn,
      openUrl: () => {},
    });

    expect(result).toEqual({ status: "error", message: "registration refused" });
    expect(closes).toHaveLength(1);
  });
});
