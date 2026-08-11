import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validateProviderKey } from "../../src/provider/validate";

const originalSkip = process.env.SERI_SKIP_KEY_VALIDATION;

beforeEach(() => {
  delete process.env.SERI_SKIP_KEY_VALIDATION;
});

afterEach(() => {
  if (originalSkip === undefined) delete process.env.SERI_SKIP_KEY_VALIDATION;
  else process.env.SERI_SKIP_KEY_VALIDATION = originalSkip;
});

describe("validateProviderKey", () => {
  test("SERI_SKIP_KEY_VALIDATION=1 skips the probe and never calls the injected generate fn", async () => {
    process.env.SERI_SKIP_KEY_VALIDATION = "1";
    let called = false;
    const result = await validateProviderKey("anthropic", "fake-key", {
      generate: (async () => {
        called = true;
        return {} as never;
      }) as never,
    });

    expect(result).toEqual({ ok: true, checked: false });
    expect(called).toBe(false);
  });

  // The AI SDK's own APICallError is an Error subclass carrying `statusCode` (isAuthFailure's own
  // comment) — mirrored here as `Object.assign(new Error(...), {statusCode})` rather than a plain
  // object literal, so this fixture matches what the real SDK actually throws instead of a shape
  // that happens to satisfy `isAuthFailure`'s structural check without also being a real Error.
  test("a 401 rejects the key", async () => {
    const result = await validateProviderKey("anthropic", "fake-key", {
      generate: (async () => {
        throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      }) as never,
    });

    expect(result).toEqual({ ok: false, reason: "auth", message: "unauthorized" });
  });

  test("a 403 rejects the key", async () => {
    const result = await validateProviderKey("anthropic", "fake-key", {
      generate: (async () => {
        throw Object.assign(new Error("forbidden"), { statusCode: 403 });
      }) as never,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "auth" });
  });

  test("a 429 stores the key anyway, with a warning", async () => {
    const result = await validateProviderKey("anthropic", "fake-key", {
      generate: (async () => {
        throw Object.assign(new Error("rate limited"), { statusCode: 429 });
      }) as never,
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ checked: false, warning: "rate limited" });
  });

  test("a plain network Error stores the key anyway, with a warning", async () => {
    const result = await validateProviderKey("anthropic", "fake-key", {
      generate: (async () => {
        throw new Error("fetch failed");
      }) as never,
    });

    expect(result).toEqual({ ok: true, checked: false, warning: "fetch failed" });
  });

  test("a non-Error throw stores the key anyway, with a warning", async () => {
    const result = await validateProviderKey("anthropic", "fake-key", {
      generate: (async () => {
        // biome-ignore lint/style/useThrowOnlyError: exercising the non-Error-throw path deliberately.
        throw "boom";
      }) as never,
    });

    expect(result).toEqual({ ok: true, checked: false, warning: "boom" });
  });

  test("a successful probe reports checked: true", async () => {
    const result = await validateProviderKey("anthropic", "fake-key", {
      generate: (async () => ({ text: "hi" })) as never,
    });

    expect(result).toEqual({ ok: true, checked: true });
  });

  // Bug fixed here (reviewer-verifier, multi-provider-byok-phase-2): an empty key used to reach
  // getAnthropicModel(modelId, "")'s own `if (!apiKey) throw` guard from inside the (then-
  // unguarded) provider switch, making this function REJECT instead of resolve — an unhandled
  // rejection cli.ts's onSetupKeyEntered had no try/catch for (it trusts the "never throws"
  // contract), deadlocking /setup's own "busy" state on an empty submit. Deliberately does NOT set
  // SERI_SKIP_KEY_VALIDATION — this negative control only means something with validation actually
  // enabled, the one condition every other test in this file (and every pty test) never exercises.
  test("an empty key resolves as an auth rejection instead of throwing, with validation enabled", async () => {
    let called = false;
    const result = await validateProviderKey("anthropic", "", {
      generate: (async () => {
        called = true;
        return { text: "hi" };
      }) as never,
    });

    expect(result).toEqual({ ok: false, reason: "auth", message: "API key cannot be empty." });
    // Never even reaches the network call — rejected before the provider switch, not caught after.
    expect(called).toBe(false);
  });

  // Round-2 reviewer-verifier finding: the empty-key check above used to sit AFTER the
  // SERI_SKIP_KEY_VALIDATION short-circuit, so under that test-only escape hatch an empty key
  // returned `{ok: true}` — and onSetupKeyEntered (cli.ts) has nothing else guarding against
  // storing that empty string into config.json (setConfigValue doesn't reject empties; only
  // configCommand's own CLI path does, which /setup never calls). The escape hatch is for skipping
  // the NETWORK probe, not for waiving "was anything even typed" — this must still reject
  // regardless of SERI_SKIP_KEY_VALIDATION.
  test("an empty key is still rejected even with SERI_SKIP_KEY_VALIDATION=1", async () => {
    process.env.SERI_SKIP_KEY_VALIDATION = "1";
    const result = await validateProviderKey("anthropic", "");

    expect(result).toEqual({ ok: false, reason: "auth", message: "API key cannot be empty." });
  });

  // Bug fixed here (code-review, PR #73): an unrecognized provider (unreachable through the real
  // ModelProvider union — this is belt-and-braces, mirroring getModel's own default case, model.ts)
  // used to `throw`, breaking this function's own documented "never throws" contract. Now returns
  // an ok:false result instead, same as every other rejection here.
  test("an unrecognized provider returns ok:false instead of throwing", async () => {
    const badProvider = "mistral" as unknown as Parameters<typeof validateProviderKey>[0];
    let called = false;
    const result = await validateProviderKey(badProvider, "fake-key", {
      generate: (async () => {
        called = true;
        return { text: "hi" };
      }) as never,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "auth" });
    expect(called).toBe(false);
  });
});
