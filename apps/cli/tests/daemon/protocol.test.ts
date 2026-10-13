import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileDir } from "../../src/config/paths";
import { resolveTurnPermissionsDir, turnRequestSchema } from "../../src/daemon/protocol";
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

describe("turnRequestSchema env", () => {
  test("omitted env inherits; a record replaces; empty object replaces with nothing", () => {
    const omitted = turnRequestSchema.safeParse({ task: "hi" });
    expect(omitted.success).toBe(true);
    if (!omitted.success) return;
    expect(omitted.data.env.spawnOptions()).toEqual({});

    const replaced = turnRequestSchema.safeParse({
      task: "hi",
      env: { FOO: "b", LS_COLORS: "a=b" },
    });
    expect(replaced.success).toBe(true);
    if (!replaced.success) return;
    expect(replaced.data.env.spawnOptions()).toEqual({ env: { FOO: "b", LS_COLORS: "a=b" } });

    const empty = turnRequestSchema.safeParse({ task: "hi", env: {} });
    expect(empty.success).toBe(true);
    if (!empty.success) return;
    expect(empty.data.env.spawnOptions()).toEqual({ env: {} });
  });

  test("rejects an empty name or a NUL byte, and accepts equals in values", () => {
    expect(turnRequestSchema.safeParse({ task: "hi", env: { "": "x" } }).success).toBe(false);
    expect(turnRequestSchema.safeParse({ task: "hi", env: { "A\0B": "x" } }).success).toBe(false);
    expect(turnRequestSchema.safeParse({ task: "hi", env: { A: "x\0y" } }).success).toBe(false);
    expect(turnRequestSchema.safeParse({ task: "hi", env: { FOO: "a=b" } }).success).toBe(true);
  });
});

describe("turnRequestSchema permissionPrompts", () => {
  test("omit and none parse; live and other values do not", () => {
    expect(turnRequestSchema.safeParse({ task: "hi" }).success).toBe(true);
    expect(turnRequestSchema.safeParse({ task: "hi", permissionPrompts: "none" }).success).toBe(
      true,
    );
    expect(turnRequestSchema.safeParse({ task: "hi", permissionPrompts: "live" }).success).toBe(
      false,
    );
    expect(turnRequestSchema.safeParse({ task: "hi", permissionPrompts: "auto" }).success).toBe(
      false,
    );
  });
});

describe("turnRequestSchema profile", () => {
  test("omitted profile is undefined; a valid name is kept", () => {
    const omitted = turnRequestSchema.safeParse({ task: "hi" });
    expect(omitted.success).toBe(true);
    if (!omitted.success) return;
    expect(omitted.data.profile).toBeUndefined();

    const named = turnRequestSchema.safeParse({ task: "hi", profile: "strict" });
    expect(named.success).toBe(true);
    if (!named.success) return;
    expect(named.data.profile).toBe("strict");
  });

  test("rejects empty, reserved, and illegal profile names", () => {
    expect(turnRequestSchema.safeParse({ task: "hi", profile: "" }).success).toBe(false);
    expect(turnRequestSchema.safeParse({ task: "hi", profile: "sessions" }).success).toBe(false);
    expect(turnRequestSchema.safeParse({ task: "hi", profile: "strict/../x" }).success).toBe(false);
    expect(turnRequestSchema.safeParse({ task: "hi", profile: "a\0b" }).success).toBe(false);
  });
});

describe("resolveTurnPermissionsDir", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  test("omitted profile keeps the daemon dir; a named existing profile is that profile's dir", () => {
    const home = makeDir();
    process.env.HOME = home;
    const daemonDir = home;
    expect(resolveTurnPermissionsDir(undefined, daemonDir)).toBe(daemonDir);

    const strictDir = profileDir("strict");
    mkdirSync(strictDir, { recursive: true });
    expect(resolveTurnPermissionsDir("strict", daemonDir)).toBe(strictDir);
  });

  test("a named profile whose directory does not exist is unknown", () => {
    process.env.HOME = makeDir();
    expect(resolveTurnPermissionsDir("missing", process.env.HOME)).toBeUndefined();
  });

  test("a named profile that is a file, not a directory, is unknown", () => {
    const home = makeDir();
    process.env.HOME = home;
    mkdirSync(join(home, ".seri"), { recursive: true });
    writeFileSync(profileDir("strict"), "not-a-directory");
    expect(resolveTurnPermissionsDir("strict", home)).toBeUndefined();
  });

  test("a named profile whose permissions.yaml does not parse is unknown", () => {
    const home = makeDir();
    process.env.HOME = home;
    const strictDir = profileDir("strict");
    mkdirSync(strictDir, { recursive: true });
    writeFileSync(
      join(strictDir, "permissions.yaml"),
      "global: []\nprojects: {}\ndeny:\n\t- write_file(/x)\n",
    );
    expect(resolveTurnPermissionsDir("strict", home)).toBeUndefined();
  });
});

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

describe("daemon turn profile", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  test("POST /v1/turns with a missing profile directory is 400 and does not start a turn", async () => {
    const home = makeDir();
    process.env.HOME = home;
    const seen: string[] = [];
    const daemon = await startDaemon({
      configDir: home,
      executeTurn: async (input) => {
        seen.push(input.permissionsDir ?? "none");
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
    });
    stop = daemon.stop;
    const response = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "hi", profile: "strict" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unknown profile" });
    expect(seen).toEqual([]);
  });

  test("POST /v1/turns with an unreadable named-profile yaml is 400 and does not start a turn", async () => {
    const home = makeDir();
    process.env.HOME = home;
    const strictDir = profileDir("strict");
    mkdirSync(strictDir, { recursive: true });
    writeFileSync(
      join(strictDir, "permissions.yaml"),
      "global: []\nprojects: {}\ndeny:\n\t- write_file(/x)\n",
    );
    const seen: string[] = [];
    const daemon = await startDaemon({
      configDir: home,
      executeTurn: async (input) => {
        seen.push(input.permissionsDir ?? "none");
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
    });
    stop = daemon.stop;
    const response = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "hi", profile: "strict" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unknown profile" });
    expect(seen).toEqual([]);
  });

  test("POST /v1/turns with a reserved profile name is 400 invalid turn request", async () => {
    const home = makeDir();
    process.env.HOME = home;
    const daemon = await startDaemon({
      configDir: home,
      executeTurn: idleTurn,
    });
    stop = daemon.stop;
    const response = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "hi", profile: "sessions" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid turn request" });
  });

  test("a named profile's permissionsDir is the profile directory, not the daemon's", async () => {
    const home = makeDir();
    process.env.HOME = home;
    const strictDir = profileDir("strict");
    mkdirSync(strictDir, { recursive: true });
    const seen: string[] = [];
    const daemon = await startDaemon({
      configDir: home,
      executeTurn: async (input) => {
        seen.push(input.permissionsDir ?? "none");
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
    });
    stop = daemon.stop;
    const named = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "hi", profile: "strict" }),
    });
    expect(named.status).toBe(200);
    await named.text();
    const omitted = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "hi" }),
    });
    expect(omitted.status).toBe(200);
    await omitted.text();
    expect(seen).toEqual([strictDir, home]);
  });
});
