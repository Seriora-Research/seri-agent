import { describe, expect, test } from "bun:test";
import { getModel } from "../../src/provider/model";

describe("getModel", () => {
  test("dispatches to getGroqModel for provider: groq", () => {
    const calls: string[] = [];
    const fakeGroqModel = {} as ReturnType<typeof getModel>;
    const model = getModel("some-id", "groq", "test-session-id", {
      getGroqModel: (id) => {
        calls.push(id);
        return fakeGroqModel;
      },
      getOpenRouterModel: () => {
        throw new Error("should not be called");
      },
    });
    expect(model).toBe(fakeGroqModel);
    expect(calls).toEqual(["some-id"]);
  });

  test("dispatches to getOpenRouterModel for provider: openrouter", () => {
    const calls: Array<{ id: string; sessionId: string }> = [];
    const fakeOpenRouterModel = {} as ReturnType<typeof getModel>;
    const model = getModel("some-id", "openrouter", "test-session-id", {
      getGroqModel: () => {
        throw new Error("should not be called");
      },
      getOpenRouterModel: (id, sessionId) => {
        calls.push({ id, sessionId });
        return fakeOpenRouterModel;
      },
    });
    expect(model).toBe(fakeOpenRouterModel);
    // The one new assertion this plan adds: sessionId must actually flow through to
    // getOpenRouterModel, unchanged, alongside the model id — that plumbing is the actual
    // change this plan makes.
    expect(calls).toEqual([{ id: "some-id", sessionId: "test-session-id" }]);
  });

  // Code-review finding: `provider` can arrive from a bare JSON.parse (session.ts's loadSession
  // has no schema check), so a value neither "groq" nor "openrouter" is a real, reachable case,
  // not just a type-system impossibility — it must throw a clear error, not silently route to
  // OpenRouter (the old ternary's fallback branch).
  test("throws naming the value for an unrecognized provider, instead of silently routing to OpenRouter", () => {
    const badProvider = "anthropic" as unknown as Parameters<typeof getModel>[1];
    expect(() =>
      getModel("some-id", badProvider, "test-session-id", {
        getGroqModel: () => {
          throw new Error("should not be called");
        },
        getOpenRouterModel: () => {
          throw new Error("should not be called");
        },
      }),
    ).toThrow(/Unknown model provider.*anthropic/);
  });
});
