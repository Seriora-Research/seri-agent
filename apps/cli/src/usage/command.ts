import type { ModelCatalog } from "@seri/model-catalog";
import { getModelCatalog } from "../provider/catalog";
import { fetchUsageReport } from "./fetch";
import { formatUsageReport, LOGGED_OUT_USAGE, type CachePrice } from "./format";

export type UsageCommandPresenter = { message: (text: string) => void };

export type RunUsageOpts = {
  detail?: boolean;
  presenter?: UsageCommandPresenter;
  fetchUsage?: typeof fetchUsageReport;
  getCatalog?: typeof getModelCatalog;
};

function cachePrices(catalog: ModelCatalog): Map<string, CachePrice> {
  const prices = new Map<string, CachePrice>();
  for (const entry of catalog.entries) {
    const pricing = entry.pricing;
    if (pricing?.cacheReadPerMTok === undefined) continue;
    prices.set(entry.id, {
      inputPerMTok: pricing.inputPerMTok,
      cacheReadPerMTok: pricing.cacheReadPerMTok,
    });
  }
  return prices;
}

function presentLines(presenter: UsageCommandPresenter, text: string): void {
  // One message per logical line: tuiPresenter.message is one transcript-append, and
  // memoryCommand already splits the same way so a multi-line report is not one transcript entry.
  for (const line of text.split("\n")) presenter.message(line);
}

export async function runUsageCommand(configDir: string, opts: RunUsageOpts = {}): Promise<void> {
  const presenter = opts.presenter ?? { message: (text) => console.log(text) };
  const fetchUsage = opts.fetchUsage ?? fetchUsageReport;
  const getCatalog = opts.getCatalog ?? getModelCatalog;
  const detail = opts.detail === true;

  const result = await fetchUsage(configDir);
  if (result.status === "logged-out") {
    presentLines(presenter, LOGGED_OUT_USAGE);
    return;
  }
  if (result.status === "error") {
    throw new Error(result.message);
  }
  let cachePriceByModel = new Map<string, CachePrice>();
  try {
    cachePriceByModel = cachePrices(await getCatalog());
  } catch {
    // Cache-dollar savings are catalog-estimated and optional; a catalog
    // failure must not hide a successfully fetched ledger report.
  }
  const staleFrom = result.status === "stale" ? result.fetchedAt : undefined;
  presentLines(
    presenter,
    formatUsageReport(result.report, {
      detail,
      staleFrom,
      cachePriceByModel,
    }),
  );
}
