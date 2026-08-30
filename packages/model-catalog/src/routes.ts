import type { ModelCatalogEntry } from "./types";

// D1 (feature-plan.md, multi-provider-byok-phase-2): route identity is a normalized `vendor/slug`
// key, not the entry's raw id — the catalog does NOT key the same logical model with the same id
// across providers (native ids are bare, e.g. `claude-sonnet-5`; OpenRouter's are vendor-prefixed,
// e.g. `anthropic/claude-sonnet-5`; separators also differ, `-` vs `.`). Measured directly against
// the bundled `apps/cli/src/provider/catalog-manifest.json` (350 entries, reproduced by
// routes.manifest.test.ts against the live file): 290 route groups, 60 spanning more than one
// provider, 0 groups containing two entries from the SAME provider (the over-collapse a naive
// prefix-strip could cause — `mistralai/foo` must not collide with a native `openai::foo`, which
// is exactly why `vendor` is taken from the entry's OWN provider when its id has no slash, not
// derived by stripping a prefix unconditionally).
// models.dev names the same vendor two ways: its own provider key is `xai` (so a native bare id
// like `grok-4.5` takes vendor `xai` from `entry.provider`), while OpenRouter prefixes the same
// model `x-ai/grok-4.5`. Without this alias the two never share a route key, which means they
// never group — and a route group of one has no sibling for resolveRoute to prefer, so the
// native-over-aggregator rule silently stops applying to grok specifically.
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

// First-appearance order preserved (a `Map` iterates insertion order) — both the /model picker
// (Step 4, apps/cli/src/tui/commands.ts) and routing-priority resolution (Step 3,
// apps/cli/src/provider/routing.ts) need groups in a stable, catalog-derived order, not
// re-sorted here.
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

// Every entry sharing `entry`'s own route key, `entry` itself included — the convenience form a
// single-entry caller (resolveRoute's own sibling lookup) wants, without building the whole map
// key-by-key at each call site.
export function routesFor(
  entries: ModelCatalogEntry[],
  entry: ModelCatalogEntry,
): ModelCatalogEntry[] {
  const key = routeKey(entry);
  return entries.filter((candidate) => routeKey(candidate) === key);
}
