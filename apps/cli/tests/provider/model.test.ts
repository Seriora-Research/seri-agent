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

  const otherFnsThrow = {
    getGroqModel: () => {
      throw new Error("should not be called");
    },
    getOpenRouterModel: () => {
      throw new Error("should not be called");
    },
    getAnthropicModel: () => {
      throw new Error("should not be called");
    },
    getOpenAIModel: () => {
      throw new Error("should not be called");
    },
    getGoogleModel: () => {
      throw new Error("should not be called");
    },
  };

  test("dispatches to getAnthropicModel for provider: anthropic", () => {
    const calls: string[] = [];
    const fakeAnthropicModel = {} as ReturnType<typeof getModel>;
    const model = getModel("some-id", "anthropic", "test-session-id", {
      ...otherFnsThrow,
      getAnthropicModel: (id) => {
        calls.push(id);
        return fakeAnthropicModel;
      },
    });
    expect(model).toBe(fakeAnthropicModel);
    // No sessionId leakage: getAnthropicModel takes only the model id, unlike
    // getOpenRouterModel's own two-arg signature above.
    expect(calls).toEqual(["some-id"]);
  });

  test("dispatches to getOpenAIModel for provider: openai", () => {
    const calls: string[] = [];
    const fakeOpenAIModel = {} as ReturnType<typeof getModel>;
    const model = getModel("some-id", "openai", "test-session-id", {
      ...otherFnsThrow,
      getOpenAIModel: (id) => {
        calls.push(id);
        return fakeOpenAIModel;
      },
    });
    expect(model).toBe(fakeOpenAIModel);
    expect(calls).toEqual(["some-id"]);
  });

  test("dispatches to getGoogleModel for provider: google", () => {
    const calls: string[] = [];
    const fakeGoogleModel = {} as ReturnType<typeof getModel>;
    const model = getModel("some-id", "google", "test-session-id", {
      ...otherFnsThrow,
      getGoogleModel: (id) => {
        calls.push(id);
        return fakeGoogleModel;
      },
    });
    expect(model).toBe(fakeGoogleModel);
    expect(calls).toEqual(["some-id"]);
  });

  // Code-review finding: `provider` can arrive from a bare JSON.parse (session.ts's loadSession
  // has no schema check), so a value outside the real union is a real, reachable case, not just a
  // type-system impossibility — it must throw a clear error, not silently route to OpenRouter (the
  // old ternary's fallback branch). "mistral", not "anthropic": once anthropic became a real
  // ModelProvider member, this fixture would dispatch to getAnthropicModel instead of hitting the
  // default case at all.
  test("throws naming the value for an unrecognized provider, instead of silently routing to OpenRouter", () => {
    const badProvider = "mistral" as unknown as Parameters<typeof getModel>[1];
    expect(() =>
      getModel("some-id", badProvider, "test-session-id", {
        getGroqModel: () => {
          throw new Error("should not be called");
        },
        getOpenRouterModel: () => {
          throw new Error("should not be called");
        },
      }),
    ).toThrow(/Unknown model provider.*mistral/);
  });
});
