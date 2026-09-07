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

  test("an empty key resolves as an auth rejection instead of throwing, with validation enabled", async () => {
    let called = false;
    const result = await validateProviderKey("anthropic", "", {
      generate: (async () => {
        called = true;
        return { text: "hi" };
      }) as never,
    });

    expect(result).toEqual({ ok: false, reason: "auth", message: "API key cannot be empty." });

    expect(called).toBe(false);
  });

  test("an empty key is still rejected even with SERI_SKIP_KEY_VALIDATION=1", async () => {
    process.env.SERI_SKIP_KEY_VALIDATION = "1";
    const result = await validateProviderKey("anthropic", "");

    expect(result).toEqual({ ok: false, reason: "auth", message: "API key cannot be empty." });
  });

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
