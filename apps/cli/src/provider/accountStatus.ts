import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fetchWithTimeout } from "@seri/model-catalog";
import { type Plan, toPlan } from "@seri/plans";
import { atomicWriteFile } from "../atomicWriteFile";
import { loadAuthSession } from "../auth/authStore";
import { refreshSession as refreshSessionReal } from "../auth/refresh";
import { authedFetch } from "./authedFetch";
import { gatewayBaseUrl } from "./gateway";

export const ACCOUNT_PLAN_FILENAME = "account-plan";

function accountPlanPath(configDir: string): string {
  return join(configDir, ACCOUNT_PLAN_FILENAME);
}

// Last successful /account-status plan, so /setup can name free/pro/max/ultra without
// another network call. A failed fetch keeps whatever was already here; logout clears it.
export function loadCachedAccountPlan(configDir: string): Plan | null {
  const path = accountPlanPath(configDir);
  if (!existsSync(path)) return null;
  try {
    return toPlan(readFileSync(path, "utf8").trim());
  } catch {
    return null;
  }
}

export function cacheAccountPlan(configDir: string, plan: Plan): void {
  atomicWriteFile(accountPlanPath(configDir), `${plan}\n`);
}

export function clearCachedAccountPlan(configDir: string): void {
  const path = accountPlanPath(configDir);
  if (existsSync(path)) unlinkSync(path);
}

type AccountStatusDeps = {
  fetchFn?: typeof fetch;
  refreshSession?: typeof refreshSessionReal;
  // Overridable so a test can prove the deadline actually bounds a stalled request without
  // waiting out the real default — never meant to be set outside a test.
  timeoutMs?: number;
};

// Matches @seri/model-catalog's own FETCH_TIMEOUT_MS (loadCatalog, same fetchWithTimeout helper)
// and provider/validate.ts's own AbortSignal.timeout(10_000) — the established value for this
// codebase's own best-effort, fail-closed startup network calls, not a fresh number.
const ACCOUNT_STATUS_TIMEOUT_MS = 10_000;

// Fails closed to null on anything short of a clean 200 — a missing/unknown plan is NOT free,
// the same posture apps/server/lib/quota.ts's isZeroPriceModel comment states for pricing. This
// function never throws: a plan-coverage display is not worth blocking session startup over.
export async function fetchAccountPlan(
  configDir: string,
  deps: AccountStatusDeps = {},
): Promise<Plan | null> {
  // Checked first to skip the network call entirely for a BYOK-only/logged-out session, mirroring
  // getGatewayModel's own login guard.
  if (!loadAuthSession(configDir)) return null;

  const fetchFn = deps.fetchFn ?? fetch;
  const refreshSession = deps.refreshSession ?? refreshSessionReal;

  try {
    // Without this deadline, a gateway that accepts the connection but never responds hangs this
    // call forever — the fail-closed catch below only fires once the fetch REJECTS, never while it
    // is merely pending, so an unbounded request here blocks prepareSession (and therefore CLI
    // startup) indefinitely. fetchWithTimeout's own comment explains why this is a plain
    // AbortController + setTimeout under the hood rather than AbortSignal.timeout(), and why the
    // body read below happens inside its own `read` callback rather than after it returns — the
    // deadline has to cover a stalled body just as much as a connection that never responds.
    return await fetchWithTimeout(
      authedFetch(configDir, fetchFn, refreshSession),
      `${gatewayBaseUrl(configDir)}/account-status`,
      deps.timeoutMs ?? ACCOUNT_STATUS_TIMEOUT_MS,
      async (response) => {
        if (!response.ok) return null;
        const body = await response.json();
        const plan = toPlan(body?.plan);
        if (plan !== null) cacheAccountPlan(configDir, plan);
        return plan;
      },
    );
  } catch {
    return null;
  }
}
