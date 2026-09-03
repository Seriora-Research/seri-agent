import { fetchUsageReport } from "./fetch";
import { formatUsageReport, LOGGED_OUT_USAGE } from "./format";

export type UsageCommandPresenter = { message: (text: string) => void };

export type RunUsageOpts = {
  detail?: boolean;
  presenter?: UsageCommandPresenter;
  fetchUsage?: typeof fetchUsageReport;
};

function presentLines(presenter: UsageCommandPresenter, text: string): void {
  // One message per logical line: tuiPresenter.message is one transcript-append, and
  // memoryCommand already splits the same way so a multi-line report is not one transcript entry.
  for (const line of text.split("\n")) presenter.message(line);
}

export async function runUsageCommand(configDir: string, opts: RunUsageOpts = {}): Promise<void> {
  const presenter = opts.presenter ?? { message: (text) => console.log(text) };
  const fetchUsage = opts.fetchUsage ?? fetchUsageReport;
  const detail = opts.detail === true;

  const result = await fetchUsage(configDir);
  if (result.status === "logged-out") {
    presentLines(presenter, LOGGED_OUT_USAGE);
    return;
  }
  if (result.status === "error") {
    throw new Error(result.message);
  }
  const staleFrom = result.status === "stale" ? result.fetchedAt : undefined;
  presentLines(presenter, formatUsageReport(result.report, { detail, staleFrom }));
}
