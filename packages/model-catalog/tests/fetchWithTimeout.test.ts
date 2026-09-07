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
    ).rejects.toThrow("aborted");
  });









  test("aborts a response body that never closes, even after the fetch itself already resolved", async () => {
    const fetchFn = (_url: string, init?: RequestInit): Promise<Response> => {
      const body = new ReadableStream({
        start(controller) {


          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return Promise.resolve(new Response(body));
    };

    await expect(
      fetchWithTimeout(fetchFn, "https://example.invalid", 20, async (response) => response.text()),
    ).rejects.toThrow("aborted");
  });
});
