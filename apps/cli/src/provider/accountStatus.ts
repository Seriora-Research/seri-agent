import { type Plan, toPlan } from "@seri/plans";
import { loadAuthSession } from "../auth/authStore";
import { refreshSession as refreshSessionReal } from "../auth/refresh";
import { authedFetch } from "./authedFetch";
import { gatewayBaseUrl } from "./gateway";

type AccountStatusDeps = {
  fetchFn?: typeof fetch;
  refreshSession?: typeof refreshSessionReal;
};

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
    const response = await authedFetch(
      configDir,
      fetchFn,
      refreshSession,
    )(`${gatewayBaseUrl(configDir)}/account-status`);
    if (!response.ok) return null;
    const body = await response.json();
    return toPlan(body?.plan);
  } catch {
    return null;
  }
}
