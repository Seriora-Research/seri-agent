import { writeFileSync } from "node:fs";
import { mapRawCatalog, type RawCatalogResponse } from "./catalog";
import type { ModelCatalog } from "./types";

const MODELS_DEV_URL = "https://models.dev/api.json";

// Maintainer-run only — not wired to `postinstall` or CI (research-spec.md's open questions).
// Fetches models.dev LIVE today; pinning to a specific commit/snapshot is preferable for
// reproducibility (upstream's schema has migrated before), but the mechanism for that is left as
// a follow-up, not required for this initial version. Run by hand:
//   bun run packages/model-catalog/src/generate.ts <output-path>
async function main(): Promise<void> {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error("Usage: bun run src/generate.ts <output-path>");
    process.exit(1);
  }

  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
  const raw = (await response.json()) as RawCatalogResponse;

  const catalog: ModelCatalog = {
    fetchedAt: new Date().toISOString(),
    entries: mapRawCatalog(raw),
  };
  writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`wrote ${catalog.entries.length} entries to ${outPath}`);
}

main();
