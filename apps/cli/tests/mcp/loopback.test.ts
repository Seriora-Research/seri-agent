// The one file in this feature that opens a real socket. It is still not a network test: every
// listener binds 127.0.0.1 on a port this file discovered itself, and every request is a fetch to
// that same loopback address.
import { afterEach, describe, expect, test } from "bun:test";
import { mcpCallbackUri } from "../../src/mcp/authProvider";
import { type CallbackServer, startCallbackServer } from "../../src/mcp/loopback";

let opened: CallbackServer[] = [];

afterEach(() => {
  for (const server of opened) server.close();
  opened = [];
});

// Bound all at once and only then released, so the ports are guaranteed distinct — probing them
// one at a time would hand back the same port twice.
function freePorts(count: number): number[] {
  const probes = Array.from({ length: count }, () =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }),
  );
  const ports = probes.map((probe) => probe.port);
  for (const probe of probes) probe.stop(true);
  if (ports.some((port) => port === undefined)) throw new Error("no free port was assigned");
  return ports as number[];
}

async function start(ports: readonly number[]): Promise<CallbackServer> {
  const server = await startCallbackServer({ ports });
  opened.push(server);
  return server;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the redirect actually lands", () => {
  test("a GET to the real redirect URI resolves the wait with the code", async () => {
    const server = await start(freePorts(1));
    const wait = server.waitForCallback({ expectedState: "s1", timeoutMs: 5_000 });

    const response = await fetch(`${server.redirectUri}?code=abc&state=s1&iss=https://api.exa.ai`);

    expect(response.status).toBe(200);
    expect(await wait).toEqual({
      kind: "code",
      code: "abc",
      state: "s1",
      iss: "https://api.exa.ai",
    });
  });
});

describe("a mismatched state does not burn the login", () => {
  test("it gets a 400 and the wait stays open for the real callback", async () => {
    const server = await start(freePorts(1));
    const wait = server.waitForCallback({ expectedState: "s1", timeoutMs: 5_000 });

    const impostor = await fetch(`${server.redirectUri}?code=abc&state=nope`);
    expect(impostor.status).toBe(400);
    expect(await Promise.race([wait, sleep(50).then(() => "still waiting" as const)])).toBe(
      "still waiting",
    );

    const real = await fetch(`${server.redirectUri}?code=real&state=s1`);
    expect(real.status).toBe(200);
    expect(await wait).toEqual({ kind: "code", code: "real", state: "s1" });
  });
});

describe("every other way one wait can end", () => {
  test("an error response resolves denied, carrying the server's own description", async () => {
    const server = await start(freePorts(1));
    const wait = server.waitForCallback({ expectedState: undefined, timeoutMs: 5_000 });

    const response = await fetch(
      `${server.redirectUri}?error=access_denied&error_description=User+declined`,
    );

    expect(response.status).toBe(200);
    expect(await wait).toEqual({ kind: "denied", message: "User declined" });
  });

  test("the timer resolves timeout rather than rejecting", async () => {
    const server = await start(freePorts(1));
    expect(await server.waitForCallback({ expectedState: undefined, timeoutMs: 5 })).toEqual({
      kind: "timeout",
    });
  });

  test("an aborted signal resolves aborted rather than rejecting", async () => {
    const server = await start(freePorts(1));
    const controller = new AbortController();
    const wait = server.waitForCallback({
      expectedState: undefined,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    expect(await wait).toEqual({ kind: "aborted" });
  });
});

describe("close", () => {
  test("is idempotent, so cancellation racing a late callback cannot double-close", async () => {
    const server = await start(freePorts(1));
    server.close();
    expect(() => server.close()).not.toThrow();
  });
});

describe("a taken port falls through to the next candidate", () => {
  test("the redirect URI names the port that actually bound", async () => {
    const [busy, spare] = freePorts(2) as [number, number];
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: busy, fetch: () => new Response("") });
    try {
      const server = await start([busy, spare]);
      expect(server.redirectUri).toBe(mcpCallbackUri(spare));
    } finally {
      blocker.stop(true);
    }
  });
});
