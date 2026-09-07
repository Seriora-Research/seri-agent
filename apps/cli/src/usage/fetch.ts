import { fetchWithTimeout } from "@seri/model-catalog";
import { loadAuthSession } from "../auth/authStore";
import { refreshSession as refreshSessionReal } from "../auth/refresh";
import { authedFetch } from "../provider/authedFetch";
import { gatewayBaseUrl } from "../provider/gateway";
import { parseUsageReport, type UsageReport } from "./report";
import {
  readUsageSnapshot,
  snapshotIsFresh,
  writeUsageSnapshot,
  type UsageSnapshot,
} from "./snapshot";

const USAGE_TIMEOUT_MS = 10_000;

type FetchUsageDeps = {
  fetchFn?: typeof fetch;
  refreshSession?: typeof refreshSessionReal;
  timeoutMs?: number;
  now?: Date;
};

export type FetchUsageResult =
  | { status: "logged-out" }
  | { status: "ok"; report: UsageReport }
  | { status: "stale"; report: UsageReport; fetchedAt: string }
  | { status: "error"; message: string };

export async function fetchUsageReport(
  configDir: string,
  deps: FetchUsageDeps = {},
): Promise<FetchUsageResult> {
  if (!loadAuthSession(configDir)) return { status: "logged-out" };

  const fetchFn = deps.fetchFn ?? fetch;
  const refreshSession = deps.refreshSession ?? refreshSessionReal;
  const now = deps.now ?? new Date();

  let report: UsageReport | null = null;
  try {
    report = await fetchWithTimeout(
      authedFetch(configDir, fetchFn, refreshSession),
      `${gatewayBaseUrl(configDir)}/usage`,
      deps.timeoutMs ?? USAGE_TIMEOUT_MS,
      async (response) => {
        if (!response.ok) return null;
        return parseUsageReport(await response.json());
      },
    );
  } catch {

  }

  if (report !== null) {
    try {
      writeUsageSnapshot(configDir, { fetchedAt: now.toISOString(), report });
    } catch {

    }
    return { status: "ok", report };
  }

  const snapshot: UsageSnapshot | undefined = readUsageSnapshot(configDir);
  if (snapshot !== undefined && snapshotIsFresh(snapshot, now)) {
    return { status: "stale", report: snapshot.report, fetchedAt: snapshot.fetchedAt };
  }
  return { status: "error", message: "Could not load hosted usage. Try again in a moment." };
}
