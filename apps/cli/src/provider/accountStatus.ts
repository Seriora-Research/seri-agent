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

  timeoutMs?: number;
};

const ACCOUNT_STATUS_TIMEOUT_MS = 10_000;

export async function fetchAccountPlan(
  configDir: string,
  deps: AccountStatusDeps = {},
): Promise<Plan | null> {
  if (!loadAuthSession(configDir)) return null;

  const fetchFn = deps.fetchFn ?? fetch;
  const refreshSession = deps.refreshSession ?? refreshSessionReal;

  try {
    return await fetchWithTimeout(
      authedFetch(configDir, fetchFn, refreshSession),
      `${gatewayBaseUrl(configDir)}/account-status`,
      deps.timeoutMs ?? ACCOUNT_STATUS_TIMEOUT_MS,
      async (response) => {
        if (!response.ok) return loadCachedAccountPlan(configDir);
        const body = await response.json();
        const plan = toPlan(body?.plan);
        if (plan !== null) cacheAccountPlan(configDir, plan);
        return plan ?? loadCachedAccountPlan(configDir);
      },
    );
  } catch {
    return loadCachedAccountPlan(configDir);
  }
}
