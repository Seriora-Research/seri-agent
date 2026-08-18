import { describe, expect, test } from "bun:test";
import { fetchWithTimeout } from "../src/fetchWithTimeout";

describe("fetchWithTimeout", () => {
  test("returns read's result when the fetch and the read both settle before the deadline", async () => {
    const fetchFn = async () => new Response("ok");

    const result = await fetchWithTimeout(
      fetchFn,
      "https://example.invalid",
      1000,
      async (response) => response.status,
    );

    expect(result).toBe(200);
  });

  test("aborts a fetch call whose headers never arrive", async () => {
    const fetchFn = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    await expect(
      fetchWithTimeout(fetchFn, "https://example.invalid", 20, async (response) => response.status),
    ).rejects.toThrow();
  });

  // The regression this file exists to close (CodeRabbit finding on PR #128): `fetchFn` resolving
  // only means the response HEADERS arrived, not that the whole response did. An earlier version
  // returned the bare `Response` and cleared the timer the moment `fetchFn` settled, so a caller's
  // own LATER body read (outside this function entirely) had no timeout guarding it at all — a
  // response whose body stream never closes hung forever past this function's own return. `read`
  // now runs inside the same try the timer lives in, so a hung body read still trips the deadline
  // — mirroring how a real fetch() Response's body reader is tied to the SAME AbortSignal the
  // initial request used, which the fake response body below reproduces explicitly.
  test("aborts a response body that never closes, even after the fetch itself already resolved", async () => {
    const fetchFn = (_url: string, init?: RequestInit): Promise<Response> => {
      const body = new ReadableStream({
        start(controller) {
          // Never enqueues or closes on its own — the deadline firing is the only thing that
          // ever settles a read against this stream.
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return Promise.resolve(new Response(body));
    };

    await expect(
      fetchWithTimeout(fetchFn, "https://example.invalid", 20, async (response) => response.text()),
    ).rejects.toThrow();
  });
});
