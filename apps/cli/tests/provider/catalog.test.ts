import { describe, expect, test } from "bun:test";
import { getModelCatalog } from "../../src/provider/catalog";

// Just the CLI wrapper's own behavior — @seri/model-catalog's fetch-with-fallback logic has its
// own tests in packages/model-catalog/tests/catalog.test.ts.
describe("getModelCatalog", () => {
  test("prints a warning exactly once when the live fetch fails, and returns the bundled fallback", async () => {
    const failingFetch: typeof fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));

    let catalog: Awaited<ReturnType<typeof getModelCatalog>>;
    try {
      catalog = await getModelCatalog(failingFetch);
    } finally {
      console.error = originalError;
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("models.dev");
    expect(catalog.entries.length).toBeGreaterThan(0);
  });
});
