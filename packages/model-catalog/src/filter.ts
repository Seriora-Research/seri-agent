import type { ModelCatalogEntry } from "./types";

// Operates on the mapped ModelCatalogEntry shape (`toolCall`), not models.dev's raw snake_case
// `tool_call` field: catalog.ts maps every provider's raw entries to ModelCatalogEntry before
// calling this, so the one curation rule this package adds never has to know the upstream shape.
export function filterCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.filter((entry) => entry.toolCall === true);
}
