import { describe, expect, test } from "bun:test";
import {
  DaemonClient,
  type DaemonEvent,
  isKnownDaemonEvent,
  iterateSse,
  snapshotProcessEnv,
} from "../src/index";

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("daemon-client", () => {
  test("sends the bearer token on every request", async () => {
    const headers: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        headers.push(req.headers.get("authorization") ?? "");
        const url = new URL(req.url);
        if (url.pathname === "/v1/health") return Response.json({ v: 1, pid: 7 });
        if (url.pathname === "/v1/turns") {
          return sseResponse([
            {
              v: 1,
              sessionId: "s",
              turnId: "t",
              seq: 1,
              event: { type: "turn-complete", exitCode: 0 },
            },
          ]);
        }
        return new Response("no", { status: 404 });
      },
    });
    const client = new DaemonClient({
      endpoint: `http://127.0.0.1:${server.port}`,
      token: "secret-token",
    });
    await client.health();
    for await (const _event of client.startTurn({ task: "x" })) {
    }
    server.stop();
    expect(headers.every((header) => header === "Bearer secret-token")).toBe(true);
    expect(headers).toHaveLength(2);
  });

  test("preserves SSE envelope order including unknown event variants", async () => {
    const events: DaemonEvent[] = [
      {
        v: 1,
        sessionId: "s",
        turnId: "t",
        seq: 1,
        event: { type: "loop", value: { type: "text-delta", text: "a" } },
      },
      { v: 1, sessionId: "s", turnId: "t", seq: 2, event: { type: "future-field", extra: true } },
      { v: 1, sessionId: "s", turnId: "t", seq: 3, event: { type: "turn-complete", exitCode: 0 } },
    ];
    const collected: DaemonEvent[] = [];
    for await (const event of iterateSse(sseResponse(events))) collected.push(event);
    expect(collected.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(isKnownDaemonEvent(collected[1]!.event)).toBe(false);
    expect(collected[1]!.event.type).toBe("future-field");
  });

  test("cancels the response reader when the consumer stops iterating", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const event = {
      v: 1,
      sessionId: "s",
      turnId: "t",
      seq: 1,
      event: { type: "loop", value: { type: "text-delta", text: "a" } },
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const item of iterateSse(new Response(stream))) {
      if (item.seq === 1) break;
    }
    expect(cancelled).toBe(true);
  });

  test("startTurn without maxDurationSeconds does not GET /v1/health", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        paths.push(url.pathname);
        if (url.pathname === "/v1/turns") {
          return sseResponse([
            {
              v: 1,
              sessionId: "s",
              turnId: "t",
              seq: 1,
              event: { type: "turn-complete", exitCode: 0 },
            },
          ]);
        }
        return new Response("no", { status: 404 });
      },
    });
    const client = new DaemonClient({
      endpoint: `http://127.0.0.1:${server.port}`,
      token: "secret-token",
    });
    await Array.fromAsync(client.startTurn({ task: "x" }));
    server.stop();
    expect(paths).toEqual(["/v1/turns"]);
  });

  test("startTurn with maxDurationSeconds refuses a daemon that does not advertise the limit", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        paths.push(url.pathname);
        if (url.pathname === "/v1/health") return Response.json({ v: 1, pid: 7 });
        return new Response("no", { status: 404 });
      },
    });
    const client = new DaemonClient({
      endpoint: `http://127.0.0.1:${server.port}`,
      token: "secret-token",
    });
    await expect(
      Array.fromAsync(client.startTurn({ task: "x", maxDurationSeconds: 2 })),
    ).rejects.toThrow("this daemon does not honor a wall-clock limit");
    server.stop();
    expect(paths).toEqual(["/v1/health"]);
  });

  test("startTurn with maxDurationSeconds POSTs after a daemon that advertises the limit", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        paths.push(url.pathname);
        if (url.pathname === "/v1/health")
          return Response.json({ v: 1, pid: 7, maxDuration: true });
        if (url.pathname === "/v1/turns") {
          return sseResponse([
            {
              v: 1,
              sessionId: "s",
              turnId: "t",
              seq: 1,
              event: { type: "turn-complete", exitCode: 0 },
            },
          ]);
        }
        return new Response("no", { status: 404 });
      },
    });
    const client = new DaemonClient({
      endpoint: `http://127.0.0.1:${server.port}`,
      token: "secret-token",
    });
    await Array.fromAsync(client.startTurn({ task: "x", maxDurationSeconds: 2 }));
    server.stop();
    expect(paths).toEqual(["/v1/health", "/v1/turns"]);
  });

  test("createSchedule with maxDurationSeconds refuses a daemon that does not advertise the limit", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        paths.push(url.pathname);
        if (url.pathname === "/v1/health") return Response.json({ v: 1, pid: 7 });
        return new Response("no", { status: 404 });
      },
    });
    const client = new DaemonClient({
      endpoint: `http://127.0.0.1:${server.port}`,
      token: "secret-token",
    });
    await expect(
      client.createSchedule({
        task: "x",
        cwd: "/tmp",
        timing: { kind: "once", at: "2099-01-01T00:00:00.000Z" },
        allowModelReads: true,
        maxDurationSeconds: 2,
      }),
    ).rejects.toThrow("this daemon does not honor a wall-clock limit");
    server.stop();
    expect(paths).toEqual(["/v1/health"]);
  });

  test("snapshotProcessEnv copies string values and drops unset keys", () => {
    expect(snapshotProcessEnv({ FOO: "b", EMPTY: undefined, PATH: "/bin" })).toEqual({
      FOO: "b",
      PATH: "/bin",
    });
  });
});
