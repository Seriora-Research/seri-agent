import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type { Plan } from "@seri/plans";
import { isModelProvider } from "../provider/defaults";
import { type ResolvedRoute, resolveRoute } from "../provider/routing";

export const ROUTABLE_ROLES = [
  "explore",
  "plan",
  "code",
  "test",
  "oracle",
  "archivist",
] as const;

export type RoutableRole = (typeof ROUTABLE_ROLES)[number];

export type RolePin = { model: string; provider: ModelProvider };

export type RoleRoute = {
  model: string;
  provider: ModelProvider;
  viaGateway: boolean;
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
    if (env[pinKeys(role).model]) {
      if (fromEnv !== undefined) pins[role] = fromEnv;
      continue;
    }
    const fromConfig = pinFromSource(config, role);
    if (fromConfig !== undefined) pins[role] = fromConfig;
  }
  return pins;
}

export function resolveRoleRoute(
  role: RoutableRole,
  parent: ResolvedRoute,
  pins: Partial<Record<RoutableRole, RolePin>>,
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null,
): RoleRoute {
  const pin = pins[role];
  if (pin === undefined) {
    return {
      model: parent.model,
      provider: parent.provider,
      viaGateway: parent.viaGateway,
      rerouted: parent.rerouted,
      inherited: true,
    };
  }
  const resolved = resolveRoute(catalog, pin, configured, plan);
  return {
    model: resolved.model,
    provider: resolved.provider,
    viaGateway: resolved.viaGateway,
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
    viaGateway: parent.viaGateway,
    rerouted: parent.rerouted,
    inherited: true,
  };
}
