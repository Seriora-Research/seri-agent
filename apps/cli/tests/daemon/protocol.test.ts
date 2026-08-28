import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecuteTurn, startDaemon } from "../../src/daemon/server";

let dirs: string[] = [];
let stop: (() => Promise<void>) | undefined;

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-daemon-proto-"));
  dirs.push(dir);
  return dir;
}

const idleTurn: ExecuteTurn = async (input) => {
  input.emitLoop({ type: "done", reason: "no-tool-call" });
  return { exitCode: 0 };
};

afterEach(async () => {
  if (stop !== undefined) {
    await stop();
    stop = undefined;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const ROUTES: { method: string; path: string; body?: string }[] = [
  { method: "GET", path: "/v1/health" },
  { method: "POST", path: "/v1/turns", body: '{"task":"hi"}' },
  { method: "GET", path: "/v1/turns/x/events" },
  { method: "POST", path: "/v1/turns/x/approvals/y", body: '{"answer":"no"}' },
  { method: "POST", path: "/v1/turns/x/cancel" },
  { method: "GET", path: "/v1/sessions/search?q=hi" },
];

describe("daemon protocol auth", () => {
  test("missing or wrong bearer returns 401 on every route before a malformed body is parsed", async () => {
    const daemon = await startDaemon({ configDir: makeDir(), executeTurn: idleTurn });
    stop = daemon.stop;
    expect(new URL(daemon.endpoint).hostname).toBe("127.0.0.1");

    for (const route of ROUTES) {
      const missing = await fetch(`${daemon.endpoint}${route.path}`, {
        method: route.method,
        headers: { "content-type": "application/json" },
        body: route.body,
      });
      expect(missing.status).toBe(401);

      const wrong = await fetch(`${daemon.endpoint}${route.path}`, {
        method: route.method,
        headers: {
          authorization: "Bearer not-the-token",
          "content-type": "application/json",
        },
        body: route.body,
      });
      expect(wrong.status).toBe(401);
    }

    const malformed = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(401);

    const malformedWithAuth = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformedWithAuth.status).toBe(400);
  });
});
