import { describe, expect, test } from "bun:test";
import { getModel } from "../../src/provider/model";

describe("getModel", () => {
  test("dispatches to getGroqModel for provider: groq", () => {
    const calls: string[] = [];
    const fakeGroqModel = {} as ReturnType<typeof getModel>;
    const model = getModel("some-id", "groq", {
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
    const calls: string[] = [];
    const fakeOpenRouterModel = {} as ReturnType<typeof getModel>;
    const model = getModel("some-id", "openrouter", {
      getGroqModel: () => {
        throw new Error("should not be called");
      },
      getOpenRouterModel: (id) => {
        calls.push(id);
        return fakeOpenRouterModel;
      },
    });
    expect(model).toBe(fakeOpenRouterModel);
    expect(calls).toEqual(["some-id"]);
  });

  // Code-review finding: `provider` can arrive from a bare JSON.parse (session.ts's loadSession
  // has no schema check), so a value neither "groq" nor "openrouter" is a real, reachable case,
  // not just a type-system impossibility — it must throw a clear error, not silently route to
  // OpenRouter (the old ternary's fallback branch).
  test("throws naming the value for an unrecognized provider, instead of silently routing to OpenRouter", () => {
    const badProvider = "anthropic" as unknown as Parameters<typeof getModel>[1];
    expect(() =>
      getModel("some-id", badProvider, {
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
