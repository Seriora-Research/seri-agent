import { describe, expect, test } from "bun:test";
import { groupRoutes, type ModelCatalogEntry } from "@seri/model-catalog";
import bundledManifest from "../../src/provider/catalog-manifest.json";

// D1's own acceptance bar (feature-plan.md): the numbers measured against this exact bundled
// manifest BEFORE the plan was written — 290 route groups total, 60 spanning more than one
// provider, 0 groups containing two entries from the same provider. This is the check that would
// have caught an exact-id-only design (the research-spec's original premise): under exact-id
// grouping, the design doc's own Anthropic/OpenRouter motivating examples produce zero
// multi-provider groups, not 60. A loose lower bound (>= 40), not the exact 60, so regenerating
// the manifest from a refreshed models.dev snapshot does not break this suite over an unrelated
// catalog update — the invariant that must hold is "meaningfully more than a handful," not this
// exact snapshot's precise count.
describe("groupRoutes over the real bundled catalog manifest", () => {
  const entries = bundledManifest.entries as ModelCatalogEntry[];

  test("zero groups contain two entries from the same provider (the over-collapse guard)", () => {
    const groups = groupRoutes(entries);
    const overCollapsed = [...groups.values()].filter((group) => {
      const providers = new Set(group.map((entry) => entry.provider));
      return providers.size < group.length;
    });
    expect(overCollapsed).toEqual([]);
  });

  test("at least 40 groups span more than one provider", () => {
    const groups = groupRoutes(entries);
    const multiProvider = [...groups.values()].filter(
      (group) => new Set(group.map((entry) => entry.provider)).size > 1,
    );
    expect(multiProvider.length).toBeGreaterThanOrEqual(40);
  });
});

// The x-ai -> xai alias only earns its place if it actually merges rows in the SHIPPED manifest.
// Asserted against the real file rather than a fixture because the failure it guards against —
// native grok and OpenRouter grok sitting in two unrelated groups — is invisible to a unit test
// that builds its own entries.
describe("the xai vendor alias against the real bundled manifest", () => {
  const entries = bundledManifest.entries as ModelCatalogEntry[];

  test("at least one route group holds both a native xai row and an openrouter row", () => {
    const groups = groupRoutes(entries);
    const merged = [...groups.values()].filter((group) => {
      const providers = new Set(group.map((entry) => entry.provider));
      return providers.has("xai") && providers.has("openrouter");
    });
    expect(merged.length).toBeGreaterThan(0);
  });

  test("every native xai row still carries pricing, so a BYOK key path can be costed", () => {
    const xai = entries.filter((entry) => entry.provider === "xai");
    expect(xai.length).toBeGreaterThan(0);
    expect(xai.every((entry) => entry.pricing !== undefined)).toBe(true);
  });
});
