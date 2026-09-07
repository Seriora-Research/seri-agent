import { describe, expect, test } from "bun:test";
import { groupRoutes, type ModelCatalogEntry } from "@seri/model-catalog";
import bundledManifest from "../../src/provider/catalog-manifest.json";

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
