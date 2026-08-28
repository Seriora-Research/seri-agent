import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecuteTurn, startDaemon } from "../../src/daemon/server";
import { SessionDatabase } from "../../src/session/database";

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

describe("daemon startup imports legacy JSONL", () => {
  test("a JSONL-only sessionId is loadable on the first POST /v1/turns", async () => {
    const configDir = makeDir();
    const sessionsDir = join(configDir, "sessions");
    mkdirSync(sessionsDir);
    const header = {
      id: "legacy-sess",
      cwd: configDir,
      systemPrompt: "",
      permissionMode: "approve-each",
    };
    const jsonl = join(sessionsDir, "legacy-sess.jsonl");
    writeFileSync(
      jsonl,
      `${JSON.stringify(header)}\n${JSON.stringify({ role: "user", content: "old fact" })}\n`,
    );
    const snapshot = readFileSync(jsonl);
    const trajectoriesDir = join(configDir, "trajectories");
    mkdirSync(trajectoriesDir);
    const trajHeader = {
      v: 1,
      kind: "header",
      sessionId: "legacy-sess",
      cwd: configDir,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const trajPath = join(trajectoriesDir, "legacy-sess.jsonl");
    writeFileSync(trajPath, `${JSON.stringify(trajHeader)}\n`);
    const trajSnapshot = readFileSync(trajPath);

    const daemon = await startDaemon({
      configDir,
      idleMs: 0,
      executeTurn: idleTurn,
    });
    stop = daemon.stop;

    const response = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "continue", sessionId: "legacy-sess" }),
    });
    expect(response.status).toBe(200);
    await response.text();

    const probe = new SessionDatabase(configDir);
    try {
      expect(probe.loadSession("legacy-sess")?.messages).toEqual([
        { role: "user", content: "old fact" },
      ]);
      expect(probe.readTrajectory("legacy-sess")).toEqual([trajHeader]);
    } finally {
      probe.close();
    }
    expect(readFileSync(jsonl)).toEqual(snapshot);
    expect(readFileSync(trajPath)).toEqual(trajSnapshot);
  });
});
