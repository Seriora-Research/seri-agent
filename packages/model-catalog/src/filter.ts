import type { ModelCatalogEntry } from "./types";




export function filterCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.filter((entry) => entry.toolCall === true);
}
