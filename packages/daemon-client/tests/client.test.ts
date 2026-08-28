import { describe, expect, test } from "bun:test";
import { DaemonClient, type DaemonEvent, isKnownDaemonEvent, iterateSse } from "../src/index";

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
      // drain
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
});
