import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry } from "@seri/model-catalog";
import {
  appliedReasoningEffort,
  buildReasoningProviderOptions,
  legalTiersFor,
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

  // Round-2 review MEDIUM finding: models.dev is an external, unvalidated source — a malformed
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

  // Round-2 review item 11: `reasoningOptions` itself might not be an array at all (a single
  // object instead of a one-element array — the same class of upstream shape drift research.md's
  // own Risks section already warns is recurring for other catalog fields). Must not throw
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

  // Round-2 review item 2: `{}` (= no providerOptions sent) means "the provider's own default
  // applies," not "off" — every provider now gets a real, verified disable shape.
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
