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

  // Code-review finding (PR #73, round 2, item #2): cli.ts resolves routing against
  // `deps.authConfigDir ?? getConfigDir()`, then used to call getModel with no apiKey/configDir
  // override at all — each real get<X>Model's own default param (`apiKey = getApiKey(...)`, no
  // configDir) then read the REAL getConfigDir() instead. A caller of the exported `run(argv,
  // deps)` with `authConfigDir` pointing somewhere non-default got told "routing … (your key)" by
  // resolveRoute, then hit missingKeyError anyway from a provider constructor reading a different
  // directory. GROQ_API_KEY is cleared around this test so a real env var on the runner's own
  // machine can't mask the bug (the exact failure mode `.claude/rules/code-quality.md`'s own
  // env-var-dependence rule warns about).
  describe("apiKey resolution", () => {
    let configDir: string;
    let fakeHome: string;
    let originalGroqKey: string | undefined;
    let originalHome: string | undefined;

    beforeEach(() => {
      originalGroqKey = process.env.GROQ_API_KEY;
      delete process.env.GROQ_API_KEY;
      configDir = mkdtempSync(join(tmpdir(), "seri-model-test-"));
      // HOME is overridden too, not just GROQ_API_KEY cleared: getModel's own real default param
      // (no configDir passed) falls back to getConfigDir(), which reads a REAL directory on the
      // runner's own machine — this repo's own env-var-dependence rule (`.claude/rules/code-
      // quality.md`) is explicit that the UNSET case still needs isolating, since every dev box and
      // CI runner has HOME set to something, and that something could itself have a config.json
      // with a GROQ_API_KEY entry (this one does not today, but nothing pins that).
      // getBaseConfigDir (config/paths.ts) reads `process.env.HOME` directly, ahead of
      // `os.homedir()`, so this override is honored without the runtime-reassignment pitfall
      // that rule also documents.
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

    // The negative control this test's own point rests on: with no configDir passed at all (the
    // pre-fix call shape), the same config.json entry must NOT be found — proving the assertion
    // above actually exercises the configDir plumbing rather than getGroqModel's own default
    // lookup finding it some other way.
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

    // Code-review finding (PR #73, round 3, item #2): each get<X>Model's own `apiKey` parameter
    // has a DEFAULT (`apiKey = getApiKey(NAME)`, no configDir) — passing an explicit `undefined`
    // argument, exactly what the fix above did whenever the resolved key was absent, RE-TRIGGERS
    // that default in JS, so it silently re-resolved against the ambient default configDir instead
    // of throwing. No `getGroqModel` override here (deliberately `{}` for deps) — the REAL
    // constructor is what has the default-param re-trigger; an injected fake never exercises it.
    test("throws instead of silently authenticating with the ambient default configDir's key", () => {
      // The ambient default (ordinary getConfigDir(), i.e. fakeHome/.seri) DOES have a key —
      // exactly the case that used to be silently (and wrongly) preferred.
      setConfigValue("GROQ_API_KEY", "sk-from-ambient-default-dir", undefined);
      // The caller's OWN configDir has nothing for groq.
      expect(() => getModel("some-id", "groq", "test-session-id", {}, configDir)).toThrow(
        "GROQ_API_KEY is not set. Run: seri config set GROQ_API_KEY <your-key>",
      );
    });
  });
});
