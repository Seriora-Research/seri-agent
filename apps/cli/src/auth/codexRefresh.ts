import {
  type CodexJsonRpc,
  type ConnectCodexAppServerOpts,
  connectCodexAppServer,
} from "./codexAppServer";
import { credentialFromCodexAuth, hasCodexSubscription, loadCodexAuth } from "./codexAuthStore";
import type { RefreshSubscription, SubscriptionCredential } from "./subscription";

export type CodexRefreshResult =
  | { status: "ok"; credential: SubscriptionCredential }
  | { status: "not-connected" }
  | { status: "not-installed"; message: string }
  | { status: "error"; message: string };

const inFlightRefreshes = new Map<string, Promise<CodexRefreshResult>>();

export type RefreshCodexOpts = ConnectCodexAppServerOpts & {
  rpc?: CodexJsonRpc;
};

export function refreshCodexSubscription(
  configDir: string,
  opts: RefreshCodexOpts = {},
): Promise<CodexRefreshResult> {
  const key = process.env.CODEX_HOME ?? configDir;
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const promise = refreshCodexSubscriptionOnce(opts);
  inFlightRefreshes.set(key, promise);
  promise.finally(() => inFlightRefreshes.delete(key)).catch(() => {});
  return promise;
}

async function refreshCodexSubscriptionOnce(opts: RefreshCodexOpts): Promise<CodexRefreshResult> {
  if (!hasCodexSubscription(opts.env ?? process.env)) {
    return { status: "not-connected" };
  }

  let rpc = opts.rpc;
  const closeOwned = rpc === undefined;
  try {
    rpc ??= await connectCodexAppServer(opts);
    const account = await rpc.request("account/read", { refreshToken: true });
    rememberPlanType(account);
    const auth = loadCodexAuth(opts.env ?? process.env);
    if (auth === undefined || auth.authMode !== "chatgpt") {
      return { status: "not-connected" };
    }
    const tokens = credentialFromCodexAuth(auth);
    return {
      status: "ok",
      credential: { provider: "openai", ...tokens },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not installed")) {
      return { status: "not-installed", message };
    }
    return { status: "error", message };
  } finally {
    if (closeOwned) rpc?.close();
  }
}

export const refreshCodexCredential: RefreshSubscription = async (configDir) => {
  const result = await refreshCodexSubscription(configDir);
  if (result.status !== "ok") {
    throw new Error(
      result.status === "not-connected"
        ? "No ChatGPT plan is connected. Run `codex login`, then /setup."
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
      if (typeof effort === "string") return [effort];
      if (typeof effort === "object" && effort !== null && "effort" in effort) {
        const named = (effort as { effort?: unknown }).effort;
        return typeof named === "string" ? [named] : [];
      }
      return [];
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

export async function listCodexModels(opts: RefreshCodexOpts = {}): Promise<CodexListedModel[]> {
  const now = Date.now();
  if (cachedModels !== undefined && now - cachedModelsAt < MODEL_LIST_CACHE_MS) {
    return cachedModels;
  }
  let rpc = opts.rpc;
  const closeOwned = rpc === undefined;
  try {
    rpc ??= await connectCodexAppServer(opts);
    const listed = parseModelList(await rpc.request("model/list"));
    try {
      rememberPlanType(await rpc.request("account/read"));
    } catch {
      // planType is chrome; a failed account/read must not drop the model list
    }
    cachedModels = listed;
    cachedModelsAt = now;
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
