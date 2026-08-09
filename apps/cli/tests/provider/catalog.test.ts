import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CATALOG_MODULE = pathToFileURL(join(import.meta.dir, "../../src/provider/catalog.ts")).href;

// A separate process, not an in-process call to getModelCatalog: @seri/model-catalog caches its
// own fetch result for the lifetime of the process (packages/model-catalog/src/catalog.ts's own
// module-level `cached`), and cli.ts's own prepareSession (Stage 7a Slice 4) now calls
// getModelCatalog on every run — including every run this suite's own cli.test.ts makes, which
// runs in the same `bun test` process as this file. An in-process call here would risk reading
// whatever one of THOSE calls already cached, rather than genuinely exercising the fetch-fails-
// and-falls-back path this test is about. A fresh process is what guarantees a pristine cache
// regardless of what else this suite already ran, and in which order.
describe("getModelCatalog", () => {
  test("prints a warning exactly once when the live fetch fails, and returns the bundled fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-catalog-test-"));
    try {
      const scriptPath = join(dir, "script.mjs");
      writeFileSync(
        scriptPath,
        [
          `const { getModelCatalog } = await import(${JSON.stringify(CATALOG_MODULE)});`,
          `const errors = [];`,
          `const originalError = console.error;`,
          `console.error = (msg) => errors.push(String(msg));`,
          `const failingFetch = async () => { throw new Error("network down"); };`,
          `let catalog;`,
          `try {`,
          `  catalog = await getModelCatalog(failingFetch);`,
          `} finally {`,
          `  console.error = originalError;`,
          `}`,
          `console.log(JSON.stringify({ errors, entryCount: catalog.entries.length }));`,
        ].join("\n"),
      );

      const output = execFileSync(process.execPath, [scriptPath], { encoding: "utf8" });
      const { errors, entryCount } = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("models.dev");
      expect(entryCount).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
