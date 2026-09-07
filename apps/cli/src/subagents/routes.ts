import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type { Plan } from "@seri/plans";
import { isModelProvider } from "../provider/defaults";
import { type ResolvedRoute, type RouteCredential, resolveRoute } from "../provider/routing";

const EMPTY_SUBSCRIPTIONS: ReadonlySet<ModelProvider> = new Set();

export const ROUTABLE_ROLES = ["explore", "plan", "code", "test", "oracle", "archivist"] as const;

export type RoutableRole = (typeof ROUTABLE_ROLES)[number];





export function isRoutableRole(value: string): value is RoutableRole {
  return (ROUTABLE_ROLES as readonly string[]).includes(value);
}

export type RolePin = { model: string; provider: ModelProvider };

export type TaskRouteRequest = {
  model?: string;
  provider?: string;
  effort?: string;
};

export type RoleRoute = {
  model: string;
  provider: ModelProvider;
  credential: RouteCredential;
  rerouted: boolean;
  inherited: boolean;
};

function pinKeys(role: RoutableRole): { model: string; provider: string } {
  const upper = role.toUpperCase();
  return {
    model: `SERI_ROLE_${upper}_MODEL`,
    provider: `SERI_ROLE_${upper}_PROVIDER`,
  };
}

function pinFromSource(
  source: Record<string, string | undefined>,
  role: RoutableRole,
): RolePin | undefined {
  const keys = pinKeys(role);
  const model = source[keys.model];
  if (typeof model !== "string" || model.length === 0) return undefined;
  const provider = source[keys.provider];
  if (typeof provider !== "string" || !isModelProvider(provider)) return undefined;
  return { model, provider };
}




export function parseRolePins(
  env: Record<string, string | undefined>,
  config: Record<string, string>,
): Partial<Record<RoutableRole, RolePin>> {
  const pins: Partial<Record<RoutableRole, RolePin>> = {};
  for (const role of ROUTABLE_ROLES) {
    const fromEnv = pinFromSource(env, role);
    if (env[pinKeys(role).model] !== undefined) {
      if (fromEnv !== undefined) pins[role] = fromEnv;
      continue;
    }
    const fromConfig = pinFromSource(config, role);
    if (fromConfig !== undefined) pins[role] = fromConfig;
  }
  return pins;
}

export function pinFromTask(request: TaskRouteRequest | undefined): RolePin | undefined {
  if (request === undefined) return undefined;
  if (typeof request.model !== "string" || request.model.length === 0) return undefined;
  if (typeof request.provider !== "string" || !isModelProvider(request.provider)) return undefined;
  return { model: request.model, provider: request.provider };
}




export function resolveChildRoute(
  role: RoutableRole | undefined,
  parent: ResolvedRoute,
  pins: Partial<Record<RoutableRole, RolePin>>,
  request: TaskRouteRequest | undefined,
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null,




  subscribed: ReadonlySet<ModelProvider> = EMPTY_SUBSCRIPTIONS,
  hostedActive = false,
): RoleRoute {
  const taskPin = pinFromTask(request);
  if (taskPin !== undefined) {
    const resolved = resolveRoute(catalog, taskPin, configured, plan, subscribed, hostedActive);
    return {
      model: resolved.model,
      provider: resolved.provider,
      credential: resolved.credential,
      rerouted: resolved.rerouted,
      inherited: false,
    };
  }
  return resolveRoleRoute(role, parent, pins, catalog, configured, plan, subscribed, hostedActive);
}

export function resolveRoleRoute(
  role: RoutableRole | undefined,
  parent: ResolvedRoute,
  pins: Partial<Record<RoutableRole, RolePin>>,
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null,
  subscribed: ReadonlySet<ModelProvider> = EMPTY_SUBSCRIPTIONS,
  hostedActive = false,
): RoleRoute {
  const pin = role === undefined ? undefined : pins[role];
  if (pin === undefined) {
    return {
      model: parent.model,
      provider: parent.provider,
      credential: parent.credential,
      rerouted: parent.rerouted,
      inherited: true,
    };
  }
  const resolved = resolveRoute(catalog, pin, configured, plan, subscribed, hostedActive);
  return {
    model: resolved.model,
    provider: resolved.provider,
    credential: resolved.credential,
    rerouted: resolved.rerouted,
    inherited: false,
  };
}

export function effortForRole(
  parent: { provider: ModelProvider; modelId: string; reasoningEffort: string | undefined },
  child: { provider: ModelProvider; modelId: string },
): string | undefined {
  if (parent.provider === child.provider && parent.modelId === child.modelId) {
    return parent.reasoningEffort;
  }
  return undefined;
}

export function effortForChild(
  parent: { provider: ModelProvider; modelId: string; reasoningEffort: string | undefined },
  child: { provider: ModelProvider; modelId: string },
  requested?: string,
): string | undefined {
  if (typeof requested === "string" && requested.length > 0) return requested;
  return effortForRole(parent, child);
}



export function realizedRoute(
  intended: RoleRoute,
  parent: ResolvedRoute,
  constructed: boolean,
): RoleRoute {
  if (constructed) return intended;
  return {
    model: parent.model,
    provider: parent.provider,
    credential: parent.credential,
    rerouted: parent.rerouted,
    inherited: true,
  };
}



export function roleConstructionWarning(
  role: string,
  intended: { provider: ModelProvider; model: string },
  detail: string,
): string {
  return `role "${role}" could not use ${intended.provider}/${intended.model} (${detail}); using the session model instead.`;
}
