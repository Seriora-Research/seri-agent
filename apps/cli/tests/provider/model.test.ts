import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigValue } from "../../src/config/config";
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

  describe("apiKey resolution", () => {
    let configDir: string;
    let fakeHome: string;
    let originalGroqKey: string | undefined;
    let originalHome: string | undefined;

    beforeEach(() => {
      originalGroqKey = process.env.GROQ_API_KEY;
      delete process.env.GROQ_API_KEY;
      configDir = mkdtempSync(join(tmpdir(), "seri-model-test-"));

      fakeHome = mkdtempSync(join(tmpdir(), "seri-model-test-home-"));
      originalHome = process.env.HOME;
      process.env.HOME = fakeHome;
    });

    afterEach(() => {
      if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalGroqKey;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(configDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    });

    test("passes the apiKey resolved from the caller's own configDir through to the provider constructor", () => {
      setConfigValue("GROQ_API_KEY", "sk-from-caller-configdir", configDir);
      const seenApiKeys: Array<string | undefined> = [];
      getModel(
        "some-id",
        "groq",
        "test-session-id",
        {
          getGroqModel: (_id, apiKey) => {
            seenApiKeys.push(apiKey);
            return {} as ReturnType<typeof getModel>;
          },
        },
        configDir,
      );
      expect(seenApiKeys).toEqual(["sk-from-caller-configdir"]);
    });

    test("without a configDir, the caller-only config.json entry is not found", () => {
      setConfigValue("GROQ_API_KEY", "sk-from-caller-configdir", configDir);
      const seenApiKeys: Array<string | undefined> = [];
      getModel("some-id", "groq", "test-session-id", {
        getGroqModel: (_id, apiKey) => {
          seenApiKeys.push(apiKey);
          return {} as ReturnType<typeof getModel>;
        },
      });
      expect(seenApiKeys).toEqual([undefined]);
    });

    test("throws instead of silently authenticating with the ambient default configDir's key", () => {
      setConfigValue("GROQ_API_KEY", "sk-from-ambient-default-dir", undefined);

      expect(() => getModel("some-id", "groq", "test-session-id", {}, configDir)).toThrow(
        "GROQ_API_KEY is not set. Set it as an environment variable and re-run.",
      );
    });
  });
});

describe("getModel for provider: xai", () => {
  test("dispatches to getXaiModel", () => {
    const calls: string[] = [];
    const fakeXaiModel = {} as ReturnType<typeof getModel>;
    const model = getModel("grok-4.3", "xai", "test-session-id", {
      getXaiModel: (id) => {
        calls.push(id);
        return fakeXaiModel;
      },
      getGroqModel: () => {
        throw new Error("should not be called");
      },
    });
    expect(model).toBe(fakeXaiModel);
    expect(calls).toEqual(["grok-4.3"]);
  });

  test("throws missingKeyError when XAI_API_KEY is absent and the real constructor would run", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-xai-"));
    try {
      expect(() => getModel("grok-4.3", "xai", "test-session-id", {}, dir)).toThrow(/XAI_API_KEY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
