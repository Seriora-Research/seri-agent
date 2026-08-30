import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry } from "@seri/model-catalog";
import { loadReasoningEffortConfig } from "../../src/config/config";
import {
  appliedReasoningEffort,
  buildReasoningProviderOptions,
  legalTiersFor,
  resolveEffortCommand,
  resolveReasoningEffort,
} from "../../src/provider/reasoning";

function entry(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    id: "some-model",
    provider: "groq",
    displayName: "Some Model",
    family: "some",
    contextWindow: 1000,
    maxOutputTokens: 100,
    toolCall: true,
    reasoning: true,
    pricing: undefined,
    ...overrides,
  };
}

describe("legalTiersFor", () => {
  test("effort-only: returns its values", () => {
    const e = entry({ reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }] });
    expect(legalTiersFor(e)).toEqual(["low", "medium", "high"]);
  });

  test("toggle-only: returns off/on", () => {
    const e = entry({ reasoningOptions: [{ type: "toggle" }] });
    expect(legalTiersFor(e)).toEqual(["off", "on"]);
  });

  test("effort+toggle together: effort's values win", () => {
    const e = entry({
      reasoningOptions: [
        { type: "toggle" },
        { type: "effort", values: ["none", "low", "medium", "high"] },
      ],
    });
    expect(legalTiersFor(e)).toEqual(["none", "low", "medium", "high"]);
  });

  test("budget_tokens-only: returns empty", () => {
    const e = entry({ reasoningOptions: [{ type: "budget_tokens" }] });
    expect(legalTiersFor(e)).toEqual([]);
  });

  test("no reasoningOptions: returns empty", () => {
    const e = entry({ reasoningOptions: undefined });
    expect(legalTiersFor(e)).toEqual([]);
  });

  test("no entry at all: returns empty", () => {
    expect(legalTiersFor(undefined)).toEqual([]);
  });

  // models.dev is an external, unvalidated source — a malformed
  // `{type: "effort"}` entry with no `values` field must not throw (`undefined.includes` at
  // loop.ts's own re-validation gate, breaking the whole turn over a catalog data problem, not
  // just /effort). `as ModelCatalogEntry["reasoningOptions"]`: deliberately bypasses the static
  // `values: string[]` requirement to model what untrusted external JSON can actually contain.
  test("malformed effort entry with no values field: returns empty rather than throwing", () => {
    const e = entry({
      reasoningOptions: [{ type: "effort" }] as unknown as ModelCatalogEntry["reasoningOptions"],
    });
    expect(() => legalTiersFor(e)).not.toThrow();
    expect(legalTiersFor(e)).toEqual([]);
  });

  // `reasoningOptions` itself might not be an array at all (a single
  // object instead of a one-element array — the same class of upstream shape drift this module
  // has to assume can recur across other catalog fields too). Must not throw
  // `TypeError: opts.find is not a function`.
  test("reasoningOptions itself is not an array: returns empty rather than throwing", () => {
    const e = entry({
      reasoningOptions: {
        type: "effort",
        values: ["low"],
      } as unknown as ModelCatalogEntry["reasoningOptions"],
    });
    expect(() => legalTiersFor(e)).not.toThrow();
    expect(legalTiersFor(e)).toEqual([]);
  });

  // `values` present but not an array (e.g. `{}` or a string) must not pass
  // through unchanged — every downstream caller relies on `.includes()`/`.join()` working.
  test("effort entry with a non-array values field: returns empty rather than the malformed value", () => {
    const e = entry({
      reasoningOptions: [
        { type: "effort", values: {} },
      ] as unknown as ModelCatalogEntry["reasoningOptions"],
    });
    expect(() => legalTiersFor(e)).not.toThrow();
    expect(legalTiersFor(e)).toEqual([]);
  });

  // A well-formed ARRAY can still carry a malformed (null) element —
  // reading `.type` off it must not throw straight out of `opts.find(...)`.
  test("a null element inside an otherwise well-formed reasoningOptions array: does not throw", () => {
    const e = entry({
      reasoningOptions: [
        null,
        { type: "effort", values: ["low", "medium"] },
      ] as unknown as ModelCatalogEntry["reasoningOptions"],
    });
    expect(() => legalTiersFor(e)).not.toThrow();
    expect(legalTiersFor(e)).toEqual(["low", "medium"]);
  });

  test("a null element with no other reasoningOptions entries: returns empty rather than throwing", () => {
    const e = entry({
      reasoningOptions: [null] as unknown as ModelCatalogEntry["reasoningOptions"],
    });
    expect(() => legalTiersFor(e)).not.toThrow();
    expect(legalTiersFor(e)).toEqual([]);
  });
});

// The shared decision behind every /effort form:
// cli.ts's own effortCommand (non-interactive) and runTui's onSubmit interception (TUI) both call
// this with an already-resolved `legalTiers`/`current` pair — tested here directly rather than
// through either caller, since neither caller's own tests should need to re-verify this decision.
describe("resolveEffortCommand", () => {
  test("bare, no override, tiers available: reports unset and lists the legal tiers", () => {
    const result = resolveEffortCommand([], ["low", "medium", "high"], undefined);
    expect(result).toEqual({
      changed: false,
      message: "Reasoning effort: unset. Legal tiers for the current model: low, medium, high.",
    });
  });

  test("bare, no tiers available at all: reports that plainly, regardless of `current`", () => {
    const result = resolveEffortCommand([], [], undefined);
    expect(result).toEqual({
      changed: false,
      message: "Reasoning effort: unset (this model has no reasoning-effort tiers available)",
    });
  });

  // A session override that is no longer legal for the CURRENTLY
  // resolved model (e.g. a stale value surviving a /model switch) must not be reported as though
  // it were still active — it is about to be silently dropped, the same fact
  // appliedReasoningEffort's own re-validation gate already enforces on the send side.
  test("bare, a session override that isn't legal for the current model: reports it as dropped, not active", () => {
    const result = resolveEffortCommand([], ["low", "medium"], "xhigh");
    expect(result).toEqual({
      changed: false,
      message:
        "Reasoning effort: xhigh is set but not legal for the current model — it will be dropped. Legal tiers: low, medium.",
    });
  });

  test("bare, a session override that IS legal: reports it as the active tier", () => {
    const result = resolveEffortCommand([], ["low", "medium"], "medium");
    expect(result).toEqual({
      changed: false,
      message: "Reasoning effort: medium. Legal tiers for the current model: low, medium.",
    });
  });

  test("auto: clears the override regardless of legal tiers", () => {
    const result = resolveEffortCommand(["auto"], ["low", "medium"], "medium");
    expect(result).toEqual({
      changed: true,
      reasoningEffort: undefined,
      message: "Reasoning effort: auto (falls back to the config default).",
    });
  });

  test("a legal tier: applies it", () => {
    const result = resolveEffortCommand(["low"], ["low", "medium"], undefined);
    expect(result).toEqual({
      changed: true,
      reasoningEffort: "low",
      message: "Reasoning effort: low",
    });
  });

  test("an illegal tier, with tiers available: reports the actual legal ones, unchanged", () => {
    const result = resolveEffortCommand(["extreme"], ["low", "medium"], undefined);
    expect(result).toEqual({
      changed: false,
      message: 'Invalid reasoning effort "extreme". Legal tiers: low, medium.',
    });
  });

  test("any single argument, with no tiers available: reports that plainly", () => {
    const result = resolveEffortCommand(["low"], [], undefined);
    expect(result).toEqual({
      changed: false,
      message: "This model has no reasoning-effort tiers available.",
    });
  });
});

describe("appliedReasoningEffort", () => {
  test("a legal tier for the entry is returned as-is", () => {
    const e = entry({ reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }] });
    expect(appliedReasoningEffort("medium", e)).toBe("medium");
  });

  test("an illegal tier for the entry resolves to undefined", () => {
    const e = entry({ reasoningOptions: [{ type: "effort", values: ["low", "medium"] }] });
    expect(appliedReasoningEffort("xhigh", e)).toBeUndefined();
  });

  test("no entry (no reasoningOptions at all) resolves to undefined", () => {
    expect(appliedReasoningEffort("medium", undefined)).toBeUndefined();
  });

  test("no tier requested resolves to undefined regardless of the entry", () => {
    const e = entry({ reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }] });
    expect(appliedReasoningEffort(undefined, e)).toBeUndefined();
  });
});

describe("loadReasoningEffortConfig", () => {
  test("reads SERI_REASONING_EFFORT from a config record", () => {
    expect(loadReasoningEffortConfig({ SERI_REASONING_EFFORT: "high" })).toBe("high");
  });

  test("absent: returns undefined", () => {
    expect(loadReasoningEffortConfig({})).toBeUndefined();
  });
});

describe("resolveReasoningEffort", () => {
  test("a session override wins over the config default", () => {
    expect(
      resolveReasoningEffort({ reasoningEffort: "high" }, { SERI_REASONING_EFFORT: "low" }),
    ).toBe("high");
  });

  test("no session override: falls back to the config default", () => {
    expect(resolveReasoningEffort({}, { SERI_REASONING_EFFORT: "low" })).toBe("low");
  });

  test("neither a session override nor a config default: undefined", () => {
    expect(resolveReasoningEffort({}, {})).toBeUndefined();
  });
});

describe("buildReasoningProviderOptions", () => {
  test("anthropic: mid-tier value maps to a fixed budgetTokens", () => {
    expect(buildReasoningProviderOptions("anthropic", "medium")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } },
    });
  });

  test("openai: mid-tier value maps to reasoningEffort", () => {
    expect(buildReasoningProviderOptions("openai", "medium")).toEqual({
      openai: { reasoningEffort: "medium" },
    });
  });

  test("groq: mid-tier value maps to reasoningEffort", () => {
    expect(buildReasoningProviderOptions("groq", "medium")).toEqual({
      groq: { reasoningEffort: "medium" },
    });
  });

  test("google: mid-tier value maps to thinkingConfig.thinkingLevel", () => {
    expect(buildReasoningProviderOptions("google", "medium")).toEqual({
      google: { thinkingConfig: { thinkingLevel: "medium" } },
    });
  });

  test("openrouter: a named effort tier maps to reasoning.effort", () => {
    expect(buildReasoningProviderOptions("openrouter", "medium")).toEqual({
      openrouter: { reasoning: { effort: "medium" } },
    });
  });

  // `{}` (= no providerOptions sent) means "the provider's own default
  // applies," not "off" — every provider needs a real, verified disable shape.
  test("off/none: anthropic gets thinking.type: disabled", () => {
    expect(buildReasoningProviderOptions("anthropic", "off")).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });
    expect(buildReasoningProviderOptions("anthropic", "none")).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });
  });

  test("off/none: google gets thinkingConfig.thinkingBudget: 0", () => {
    expect(buildReasoningProviderOptions("google", "off")).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
    expect(buildReasoningProviderOptions("google", "none")).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  test("off/none: openai and groq get reasoningEffort: none", () => {
    expect(buildReasoningProviderOptions("openai", "off")).toEqual({
      openai: { reasoningEffort: "none" },
    });
    expect(buildReasoningProviderOptions("openai", "none")).toEqual({
      openai: { reasoningEffort: "none" },
    });
    expect(buildReasoningProviderOptions("groq", "off")).toEqual({
      groq: { reasoningEffort: "none" },
    });
    expect(buildReasoningProviderOptions("groq", "none")).toEqual({
      groq: { reasoningEffort: "none" },
    });
  });

  test("off/none: openrouter gets an explicit reasoning.enabled: false", () => {
    expect(buildReasoningProviderOptions("openrouter", "off")).toEqual({
      openrouter: { reasoning: { enabled: false } },
    });
    expect(buildReasoningProviderOptions("openrouter", "none")).toEqual({
      openrouter: { reasoning: { enabled: false } },
    });
  });

  test("openrouter toggle-on path: 'on' maps to reasoning.enabled: true", () => {
    expect(buildReasoningProviderOptions("openrouter", "on")).toEqual({
      openrouter: { reasoning: { enabled: true } },
    });
  });

  test("openai/groq toggle-on path: 'on' maps to reasoningEffort medium", () => {
    expect(buildReasoningProviderOptions("openai", "on")).toEqual({
      openai: { reasoningEffort: "medium" },
    });
    expect(buildReasoningProviderOptions("groq", "on")).toEqual({
      groq: { reasoningEffort: "medium" },
    });
  });

  test("google toggle-on path: 'on' maps to thinkingLevel medium", () => {
    expect(buildReasoningProviderOptions("google", "on")).toEqual({
      google: { thinkingConfig: { thinkingLevel: "medium" } },
    });
  });
});

describe("buildReasoningProviderOptions for xai", () => {
  // The regression this exists for: @ai-sdk/openai's chat model hardcodes
  // parseProviderOptions({ provider: "openai" }), so a { xai: ... } key would be parsed against a
  // provider name nobody sends and /effort would silently do nothing on grok.
  test("keys the enabled shape on openai, not xai", () => {
    expect(buildReasoningProviderOptions("xai", "high")).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });

  test("maps the generic on tier to medium", () => {
    expect(buildReasoningProviderOptions("xai", "on")).toEqual({
      openai: { reasoningEffort: "medium" },
    });
  });

  test("keys the disabled shape on openai too", () => {
    expect(buildReasoningProviderOptions("xai", "off")).toEqual({
      openai: { reasoningEffort: "none" },
    });
    expect(buildReasoningProviderOptions("xai", "none")).toEqual({
      openai: { reasoningEffort: "none" },
    });
  });
});
