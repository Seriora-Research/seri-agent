import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type { Plan } from "@seri/plans";
import { isModelProvider } from "../provider/defaults";
import { type ResolvedRoute, type RouteCredential, resolveRoute } from "../provider/routing";

export const ROUTABLE_ROLES = ["explore", "plan", "code", "test", "oracle", "archivist"] as const;

export type RoutableRole = (typeof ROUTABLE_ROLES)[number];

// The SERI_ROLE_* surface is a closed, documented set of names, and this is the one place a
// free-form agent name is admitted to it. A file-defined agent can never satisfy this, because
// loadAgentRegistry reserves every ROUTABLE_ROLES name against agent files — so "no env pin
// exists for this agent" is decided here rather than carried on every spec.
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

// Coupled pair, same rule as resolveDefaultModel: whichever source supplies MODEL also
// supplies PROVIDER. An env MODEL with no valid env PROVIDER is unset — it does not borrow
// the config provider (or the parent session provider). Incomplete pins are unrepresentable.
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

// `role` is `undefined` for an agent with no env-pin surface at all — a file-defined one. It means
// "no pin exists", which falls through to the task request and then to inherit, not "look one up
// and find nothing".
export function resolveChildRoute(
  role: RoutableRole | undefined,
  parent: ResolvedRoute,
  pins: Partial<Record<RoutableRole, RolePin>>,
  request: TaskRouteRequest | undefined,
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null,
): RoleRoute {
  const taskPin = pinFromTask(request);
  if (taskPin !== undefined) {
    const resolved = resolveRoute(catalog, taskPin, configured, plan);
    return {
      model: resolved.model,
      provider: resolved.provider,
      credential: resolved.credential,
      rerouted: resolved.rerouted,
      inherited: false,
    };
  }
  return resolveRoleRoute(role, parent, pins, catalog, configured, plan);
}

export function resolveRoleRoute(
  role: RoutableRole | undefined,
  parent: ResolvedRoute,
  pins: Partial<Record<RoutableRole, RolePin>>,
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null,
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
  const resolved = resolveRoute(catalog, pin, configured, plan);
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

// Construction lives at the compose site. When it fails, the child runs the parent pair and
// reports inherited: true — the pair that actually ran, not the pin that could not.
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

// Takes the agent's own name, not its pin key: a file-defined agent has no pin key, and naming it
// "undefined" in a warning the user has to act on would hide which agent file to go and fix.
export function roleConstructionWarning(
  role: string,
  intended: { provider: ModelProvider; model: string },
  detail: string,
): string {
  return `role "${role}" could not use ${intended.provider}/${intended.model} (${detail}); using the session model instead.`;
}
