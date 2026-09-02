import {
  type CodexJsonRpc,
  type ConnectCodexAppServerOpts,
  connectCodexAppServer,
} from "./codexAppServer";
import {
  grantFromSubscription,
  loadUsableCodexGrant,
  saveCodexSubscription,
  subscriptionFromCodexTokens,
} from "./codexAuthStore";
import {
  extractCodexAccountId,
  refreshCodexGrant,
  codexClientId,
  codexTokenUrl,
} from "./codexOAuth";
import type { RefreshSubscription, SubscriptionCredential } from "./subscription";

export type CodexRefreshResult =
  | { status: "ok"; credential: SubscriptionCredential }
  | { status: "not-connected" }
  | { status: "reconnect-required"; message: string }
  | { status: "tier-denied"; message: string }
  | { status: "error"; message: string };

const inFlightRefreshes = new Map<string, Promise<CodexRefreshResult>>();

export type RefreshCodexOpts = ConnectCodexAppServerOpts & {
  rpc?: CodexJsonRpc;
  fetchFn?: typeof fetch;
};

export function refreshCodexSubscription(
  configDir: string,
  opts: RefreshCodexOpts = {},
): Promise<CodexRefreshResult> {
  const existing = inFlightRefreshes.get(configDir);
  if (existing) return existing;

  const promise = refreshCodexSubscriptionOnce(configDir, opts);
  inFlightRefreshes.set(configDir, promise);
  promise.finally(() => inFlightRefreshes.delete(configDir)).catch(() => {});
  return promise;
}

async function refreshCodexSubscriptionOnce(
  configDir: string,
  opts: RefreshCodexOpts,
): Promise<CodexRefreshResult> {
  const grant = loadUsableCodexGrant(configDir, opts.env ?? process.env);
  if (grant === undefined) return { status: "not-connected" };
  if (grant.refreshToken === undefined || grant.refreshToken.length === 0) {
    return {
      status: "reconnect-required",
      message: "Your ChatGPT plan session has expired. Connect it again from /setup.",
    };
  }

  try {
    const tokens = await refreshCodexGrant(
      {
        tokenUrl: codexTokenUrl(configDir),
        clientId: codexClientId(configDir),
        refreshToken: grant.refreshToken,
      },
      opts.fetchFn ?? fetch,
    );
    let accountId = grant.accountId;
    try {
      accountId = extractCodexAccountId(tokens.accessToken);
    } catch {
      // keep stored accountId
    }
    const updated = subscriptionFromCodexTokens({ ...tokens, accountId });
    saveCodexSubscription(updated, configDir);
    const credential = grantFromSubscription(updated);
    return {
      status: "ok",
      credential: {
        provider: "openai",
        accessToken: credential.accessToken,
        accountId: credential.accountId,
        expiresAt: credential.expiresAt,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "CodexTierDenied") {
      return { status: "tier-denied", message };
    }
    if (err instanceof Error && err.name === "CodexReconnectRequired") {
      return { status: "reconnect-required", message };
    }
    return { status: "error", message };
  }
}

export const refreshCodexCredential: RefreshSubscription = async (configDir) => {
  const result = await refreshCodexSubscription(configDir);
  if (result.status !== "ok") {
    throw new Error(
      result.status === "not-connected"
        ? "No ChatGPT plan is connected. Run /setup to connect one."
        : result.message,
    );
  }
  return result.credential;
};

export type CodexListedModel = {
  id: string;
  displayName: string;
  supportedReasoningEfforts: string[];
};

function reasoningEffortName(effort: unknown): string | undefined {
  if (typeof effort === "string") return effort;
  if (typeof effort !== "object" || effort === null) return undefined;
  const row = effort as Record<string, unknown>;
  if (typeof row.reasoningEffort === "string") return row.reasoningEffort;
  if (typeof row.effort === "string") return row.effort;
  return undefined;
}

export function parseModelList(result: unknown): CodexListedModel[] {
  if (typeof result !== "object" || result === null) return [];
  const obj = result as Record<string, unknown>;
  const raw = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(obj.models)
      ? obj.models
      : Array.isArray(obj.items)
        ? obj.items
        : Array.isArray(result)
          ? result
          : [];
  const models: CodexListedModel[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id =
      typeof row.id === "string" ? row.id : typeof row.slug === "string" ? row.slug : undefined;
    if (id === undefined || id.length === 0) continue;
    const displayName =
      typeof row.displayName === "string"
        ? row.displayName
        : typeof row.name === "string"
          ? row.name
          : id;
    const effortsRaw = Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts
      : Array.isArray(row.reasoningEfforts)
        ? row.reasoningEfforts
        : [];
    const supportedReasoningEfforts = effortsRaw.flatMap((effort) => {
      const named = reasoningEffortName(effort);
      return named === undefined ? [] : [named];
    });
    models.push({ id, displayName, supportedReasoningEfforts });
  }
  return models;
}

export function parseAccountRead(result: unknown): { planType: string | undefined } {
  if (typeof result !== "object" || result === null) return { planType: undefined };
  const obj = result as Record<string, unknown>;
  const nested =
    typeof obj.account === "object" && obj.account !== null
      ? (obj.account as Record<string, unknown>)
      : obj;
  const planType =
    typeof nested.planType === "string" && nested.planType.length > 0 ? nested.planType : undefined;
  return { planType };
}

let cachedModels: CodexListedModel[] | undefined;
let cachedModelsAt = 0;
let cachedPlanType: string | undefined;
const MODEL_LIST_CACHE_MS = 60 * 60 * 1000;

export function codexPlanType(): string | undefined {
  return cachedPlanType;
}

function rememberPlanType(result: unknown): void {
  const { planType } = parseAccountRead(result);
  if (planType !== undefined) cachedPlanType = planType;
}

const MODEL_LIST_PAGE = 100;
const MODEL_LIST_MAX_PAGES = 20;

function nextCursorOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const cursor = (result as { nextCursor?: unknown }).nextCursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

async function listAllCodexModelPages(rpc: CodexJsonRpc): Promise<CodexListedModel[]> {
  const models: CodexListedModel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MODEL_LIST_MAX_PAGES; page++) {
    const params: { limit: number; cursor?: string } = { limit: MODEL_LIST_PAGE };
    if (cursor !== undefined) params.cursor = cursor;
    const result = await rpc.request("model/list", params);
    models.push(...parseModelList(result));
    const next = nextCursorOf(result);
    if (next === undefined) break;
    cursor = next;
  }
  return models;
}

let inFlightList: Promise<CodexListedModel[]> | undefined;

export async function listCodexModels(opts: RefreshCodexOpts = {}): Promise<CodexListedModel[]> {
  const now = Date.now();
  if (cachedModels !== undefined && now - cachedModelsAt < MODEL_LIST_CACHE_MS) {
    return cachedModels;
  }
  // A caller-supplied rpc is owned by that caller. Only the spawn path is shared
  // across overlapping getModelCatalog fetches (prepareSession and run both call it).
  if (opts.rpc !== undefined) {
    return listCodexModelsOnce(opts);
  }
  if (inFlightList !== undefined) return inFlightList;
  const promise = listCodexModelsOnce(opts);
  inFlightList = promise;
  void promise.finally(() => {
    if (inFlightList === promise) inFlightList = undefined;
  });
  return promise;
}

async function listCodexModelsOnce(opts: RefreshCodexOpts): Promise<CodexListedModel[]> {
  const now = Date.now();
  let rpc = opts.rpc;
  const closeOwned = rpc === undefined;
  try {
    rpc ??= await connectCodexAppServer(opts);
    const listed = await listAllCodexModelPages(rpc);
    try {
      rememberPlanType(await rpc.request("account/read"));
    } catch {
      // planType is chrome; a failed account/read must not drop the model list
    }
    if (listed.length > 0) {
      cachedModels = listed;
      cachedModelsAt = now;
    }
    return listed;
  } finally {
    if (closeOwned) rpc?.close();
  }
}

export function resetCodexModelCache(): void {
  cachedModels = undefined;
  cachedModelsAt = 0;
  cachedPlanType = undefined;
}
