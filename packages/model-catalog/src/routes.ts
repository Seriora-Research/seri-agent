import type { ModelCatalogEntry } from "./types";
















const VENDOR_ALIASES: Record<string, string> = { "x-ai": "xai" };

export function routeKey(entry: ModelCatalogEntry): string {
  const slash = entry.id.indexOf("/");
  const rawVendor =
    slash === -1 ? entry.provider : entry.id.slice(0, slash).replace(/^~/, "").toLowerCase();
  const vendor = VENDOR_ALIASES[rawVendor] ?? rawVendor;
  const slug = (slash === -1 ? entry.id : entry.id.slice(slash + 1))
    .toLowerCase()
    .replace(/[._]/g, "-");
  return `${vendor}/${slug}`;
}





export function groupRoutes(entries: ModelCatalogEntry[]): Map<string, ModelCatalogEntry[]> {
  const groups = new Map<string, ModelCatalogEntry[]>();
  for (const entry of entries) {
    const key = routeKey(entry);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}




export function routesFor(
  entries: ModelCatalogEntry[],
  entry: ModelCatalogEntry,
): ModelCatalogEntry[] {
  const key = routeKey(entry);
  return entries.filter((candidate) => routeKey(candidate) === key);
}
