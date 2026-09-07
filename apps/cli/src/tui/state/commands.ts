import { randomUUID } from "node:crypto";
import {
  filterCatalogEntries,
  groupRoutes,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
} from "@seri/model-catalog";
import type { Plan } from "@seri/plans";
import type { ModelMessage } from "ai";
import { loadAgentsFile } from "../../agents/loadAgentsFile";
import { buildSystemPrompt } from "../../agents/systemPrompt";
import { hasHostedAuth, loadAuthSession } from "../../auth/authStore";
import { hasLeftoverCodexSubscription, loadCodexSubscription } from "../../auth/codexAuthStore";
import type { CodexSetupStatus } from "../../auth/codexBin";
import { isCodexSubscriptionIgnored } from "../../auth/codexIgnore";
import { codexPlanType } from "../../auth/codexRefresh";
import { type SeriSetupStatus, hostedPlanUsable, isSeriIgnored } from "../../auth/seriIgnore";
import { hasXaiSubscription } from "../../auth/xaiAuthStore";
import {
  appendBarrier,
  checkpointStoreDir,
  type RestorePlan,
  type RestoreResult,
  restoreCommit,
  rewindConversation,
  undoFiles,
} from "../../checkpoint/checkpoint";
import { projectRoot } from "../../checkpoint/shadowGit";
import { maskValue } from "../../config/commands";
import {
  BLOCK_READS_OUTSIDE_WORKING_DIRECTORIES_KEY,
  configBoolean,
  loadConfig,
  resolveConfigValue,
} from "../../config/config";
import { isDefaultProfile, profileDir, profileNameError } from "../../config/paths";
import { cycleMode } from "../../gate/gate";
import { type HooksLoad, loadHookRegistry } from "../../hooks/registry";
import { loadGrants, PERSISTABLE_TOOL_NAMES } from "../../permissions/store";
import {
  allProviderKeyStates,
  configuredProviders,
  PROVIDER_API_KEY_NAMES,
} from "../../provider/keys";
import { loadCachedAccountPlan } from "../../provider/accountStatus";
import { GATEWAY_PROVIDER } from "../../provider/planCoverage";
import { resolveReasoningEffort } from "../../provider/reasoning";
import {
  byRoutePriority,
  resolveLegalReasoningTiers,
  resolveRoute,
  resolveSessionRoute,
} from "../../provider/routing";
import { codexSubscriptionActive } from "../../provider/subscriptions";
import { loadRuleRegistry, type RuleRegistry } from "../../rules/registry";
import type { SessionState } from "../../session/session";
import { loadSkillRegistry, type SkillRegistry } from "../../skills/registry";
import type { TrajectoryWriter } from "../../trajectory/writer";

export type CommandDirs = {
  sessionsDir: string;
  checkpointsDir: string;
  configDir: string;
  trajectory?: TrajectoryWriter;
};

// Resolve the checkpoint store from the session cwd's project root, not the process start directory.
export function checkpointTarget(
  session: SessionState<ModelMessage>,
  dirs: CommandDirs,
): { storeDir: string; worktree: string } {
  const worktree = projectRoot(session.cwd);
  return { storeDir: checkpointStoreDir(dirs.checkpointsDir, worktree), worktree };
}

function steps(args: string[]): number {
  return args[0] === undefined ? 1 : Number(args[0]);
}

export function decideModeCycle(session: SessionState<ModelMessage>): {
  next: SessionState<ModelMessage>;
  message: string;
} {
  const next = { ...session, permissionMode: cycleMode(session.permissionMode) };
  return { next, message: `Session ${next.id}: permission mode is now ${next.permissionMode}` };
}

export type ModelPickerEntry = {
  entry: ModelCatalogEntry;
  keyConfigured: boolean;
  alternatives: number;
  rerouteTo?: ModelProvider;
  gatewayReachable: boolean;
  subscriptionCovered: boolean;
};

export function decideModelPickerOpen(
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
  planCoverage: (entry: ModelCatalogEntry, group: readonly ModelCatalogEntry[]) => boolean = () =>
    false,
  subscribed: ReadonlySet<ModelProvider> = new Set(),
): ModelPickerEntry[] {
  const groups = groupRoutes(filterCatalogEntries(catalog.entries));
  const rows: ModelPickerEntry[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(byRoutePriority);
    const firstUnresolved = ordered.find(
      (candidate) => !configured.has(candidate.provider) && !subscribed.has(candidate.provider),
    );
    const resolved =
      firstUnresolved === undefined
        ? undefined
        : resolveRoute(
            catalog,
            { model: firstUnresolved.id, provider: firstUnresolved.provider },
            configured,
            null,
            subscribed,
          );
    const rerouteTarget = resolved?.rerouted ? resolved.provider : undefined;
    for (const entry of ordered) {
      const keyConfigured = configured.has(entry.provider);
      const subscriptionCovered = subscribed.has(entry.provider);
      rows.push({
        entry,
        keyConfigured,
        alternatives: group.length - 1,
        rerouteTo: keyConfigured || subscriptionCovered ? undefined : rerouteTarget,
        gatewayReachable: planCoverage(entry, group),
        subscriptionCovered,
      });
    }
  }
  return rows;
}

export function decideGuidedModelPickerOpen(
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
): ModelPickerEntry[] {
  const keyed = decideModelPickerOpen(catalog, configured).filter((row) => row.keyConfigured);
  const shownGroups = groupRoutes(keyed.map((row) => row.entry));
  const shownAlternatives = new Map<ModelCatalogEntry, number>();
  for (const group of shownGroups.values()) {
    for (const entry of group) shownAlternatives.set(entry, group.length - 1);
  }
  return keyed.map((row) => ({ ...row, alternatives: shownAlternatives.get(row.entry) ?? 0 }));
}

export type SetupHeadingRow = { kind: "heading"; label: string };
export type SetupKeyRow = {
  kind: "key";
  provider: ModelProvider;
  keyName: string;
  source: "env" | "config" | "unset";
  masked: string | undefined;
  removable: boolean;
  unusedBecause?: string;
};
export type SetupGrokSubscriptionRow = {
  kind: "subscription";
  provider: "xai";
  connected: boolean;
};
export type SetupCodexSubscriptionRow = {
  kind: "subscription";
  provider: "openai";
  status: CodexSetupStatus;
  removable: boolean;
};
export type SetupSeriSubscriptionRow = {
  kind: "subscription";
  provider: "seri";
  status: SeriSetupStatus;
};
export type SetupSubscriptionRow =
  | SetupGrokSubscriptionRow
  | SetupCodexSubscriptionRow
  | SetupSeriSubscriptionRow;
export type SetupProviderRow = SetupHeadingRow | SetupKeyRow | SetupSubscriptionRow;

export function setupRowId(row: SetupProviderRow): string {
  if (row.kind === "heading") return `heading:${row.label}`;
  if (row.kind === "subscription") return `subscription:${row.provider}`;
  return `key:${row.provider}`;
}

export function isSetupActionRow(row: SetupProviderRow): row is SetupKeyRow | SetupSubscriptionRow {
  return row.kind !== "heading";
}

export function firstSetupActionIndex(rows: readonly SetupProviderRow[]): number {
  const index = rows.findIndex(isSetupActionRow);
  return index < 0 ? 0 : index;
}

export function isSetupSubscriptionRow(row: SetupProviderRow): row is SetupSubscriptionRow {
  return row.kind === "subscription";
}

function seriSetupRow(configDir?: string): SetupSeriSubscriptionRow {
  if (configDir === undefined || !hasHostedAuth(configDir)) {
    return { kind: "subscription", provider: "seri", status: { status: "not-logged-in" } };
  }
  const planType = loadCachedAccountPlan(configDir) ?? undefined;
  if (isSeriIgnored(configDir)) {
    return { kind: "subscription", provider: "seri", status: { status: "ignored", planType } };
  }
  return { kind: "subscription", provider: "seri", status: { status: "connected", planType } };
}

function codexSetupRow(configDir?: string): SetupSubscriptionRow {
  if (configDir !== undefined && loadCodexSubscription(configDir) !== undefined) {
    const planType = codexPlanType();
    return {
      kind: "subscription",
      provider: "openai",
      status: planType === undefined ? { status: "connected" } : { status: "connected", planType },
      removable: true,
    };
  }
  if (
    configDir !== undefined &&
    isCodexSubscriptionIgnored(configDir) &&
    hasLeftoverCodexSubscription()
  ) {
    return {
      kind: "subscription",
      provider: "openai",
      status: { status: "ignored" },
      removable: false,
    };
  }
  if (configDir !== undefined && codexSubscriptionActive(configDir)) {
    const planType = codexPlanType();
    return {
      kind: "subscription",
      provider: "openai",
      status: planType === undefined ? { status: "connected" } : { status: "connected", planType },
      removable: true,
    };
  }
  return {
    kind: "subscription",
    provider: "openai",
    status: { status: "not-connected" },
    removable: false,
  };
}

export function decideSetupOpen(configDir?: string): SetupProviderRow[] {
  const grokConnected = configDir !== undefined && hasXaiSubscription(configDir);
  const openaiSubscribed = configDir !== undefined && codexSubscriptionActive(configDir);
  const seriActive = configDir !== undefined && hostedPlanUsable(configDir);
  const keyRows: SetupKeyRow[] = allProviderKeyStates(configDir).map((state) => {
    let unusedBecause: string | undefined;
    if (grokConnected && state.provider === "xai" && state.source !== "unset") {
      unusedBecause = "unused because a Grok subscription is connected";
    } else if (openaiSubscribed && state.provider === "openai" && state.source !== "unset") {
      unusedBecause = "unused because a ChatGPT plan is connected";
    } else if (seriActive && state.provider === GATEWAY_PROVIDER && state.source !== "unset") {
      unusedBecause = "unused because a seri plan is connected";
    }
    return {
      kind: "key",
      provider: state.provider,
      keyName: state.keyName,
      source: state.source,
      masked: state.masked,
      removable: state.hasConfigEntry,
      unusedBecause,
    };
  });
  return [
    { kind: "heading", label: "API keys" },
    ...keyRows,
    { kind: "heading", label: "Subscriptions" },
    seriSetupRow(configDir),
    { kind: "subscription", provider: "xai", connected: grokConnected },
    codexSetupRow(configDir),
  ];
}

export function decideAuthOffer(configDir: string): boolean {
  return loadAuthSession(configDir) === undefined;
}

export type ConfigRowKind = { kind: "string" } | { kind: "boolean"; on: boolean };
export type ConfigRowBase = {
  key: string;
  masked: string;
  source: "config" | "env" | "unset";
  removable: boolean;
};
export type ConfigRow = ConfigRowBase & ConfigRowKind;

type ConfigKeyInfo = {
  label: string;
  description: string;
  kind: "boolean" | "string";
  takesEffectNextRun: boolean;
  booleanUnset?: "on" | "off";
};

// Map, not a prototype-bearing object: a user key named toString or constructor must not resolve to Object.prototype.
const CONFIG_KEY_INFO = new Map<string, ConfigKeyInfo>([
  [
    "SERI_VERIFY_ENABLED",
    {
      label: "Automatic verification",
      description: "Run the verify command after each file edit and show failures to the model.",
      kind: "boolean",
      takesEffectNextRun: true,
    },
  ],
  [
    "SERI_VERIFY_COMMAND",
    {
      label: "Verify command",
      description: 'Shell command run to verify edits, e.g. "bun run check". Unset disables it.',
      kind: "string",
      takesEffectNextRun: true,
    },
  ],
  [
    "SERI_REASONING_EFFORT",
    {
      label: "Reasoning effort",
      description: "Default reasoning effort for models that support it (e.g. low, medium, high).",
      kind: "string",
      takesEffectNextRun: false,
    },
  ],
  [
    "SERI_TEMPERATURE",
    {
      label: "Temperature",
      description: "Sampling temperature. Unset keeps the provider default and records that.",
      kind: "string",
      takesEffectNextRun: false,
    },
  ],
  [
    "SERI_SEED",
    {
      label: "Seed",
      description: "Integer seed where the provider accepts one. Unset is recorded, not assumed.",
      kind: "string",
      takesEffectNextRun: false,
    },
  ],
  [
    "SERI_OPENROUTER_PROVIDER",
    {
      label: "OpenRouter pin",
      description: "Pin OpenRouter to this upstream (no fallback). Disables sticky cache routing.",
      kind: "string",
      takesEffectNextRun: true,
    },
  ],
  [
    "SERI_TUI_BACKGROUND",
    {
      label: "Background color",
      description: "Hex ground, default #141413. Set to terminal to keep the terminal's own.",
      kind: "string",
      takesEffectNextRun: true,
    },
  ],
  [
    "SERI_ALLOW_UNSANDBOXED_COMMANDS",
    {
      label: "Unsandboxed bang",
      description: "Allow ! shell to leave the OS sandbox. Off refuses it when unsandboxed.",
      kind: "boolean",
      takesEffectNextRun: false,
    },
  ],
  [
    BLOCK_READS_OUTSIDE_WORKING_DIRECTORIES_KEY,
    {
      label: "Outside working dir",
      description: "Block paths outside the session cwd. Unset keeps the one-shot prompt.",
      kind: "boolean",
      takesEffectNextRun: false,
      booleanUnset: "off",
    },
  ],
]);
export const KNOWN_CONFIG_KEYS = [...CONFIG_KEY_INFO.keys()];

export function configKeyInfo(key: string): ConfigKeyInfo {
  return (
    CONFIG_KEY_INFO.get(key) ?? {
      label: key,
      description: "",
      kind: "string",
      takesEffectNextRun: false,
    }
  );
}

export function booleanRowOn(key: string, value: string | undefined): boolean {
  return configKeyInfo(key).booleanUnset === "off" ? value === "true" : configBoolean(value);
}

const HIDDEN_CONFIG_KEYS = ["SERI_WORKOS_CLIENT_ID", "SERI_GROK_CLIENT_ID"];

export function decideConfigOpen(configDir: string): ConfigRow[] {
  const config = loadConfig(configDir);
  const excludedKeys = new Set([
    ...KNOWN_CONFIG_KEYS,
    ...HIDDEN_CONFIG_KEYS,
    ...Object.values(PROVIDER_API_KEY_NAMES),
  ]);
  const otherKeys = Object.keys(config)
    .filter((key) => !excludedKeys.has(key))
    .sort();
  return [...KNOWN_CONFIG_KEYS, ...otherKeys].map((key) => {
    const hasConfigEntry = Object.hasOwn(config, key);
    const { value, source } = resolveConfigValue(key, config);
    const kind = configKeyInfo(key).kind;
    const secret = !CONFIG_KEY_INFO.has(key);
    const kindFields: ConfigRowKind =
      kind === "boolean" ? { kind: "boolean", on: booleanRowOn(key, value) } : { kind: "string" };
    return {
      key,
      masked: value === undefined ? "" : secret ? maskValue(value) : value,
      source,
      removable: hasConfigEntry,
      ...kindFields,
    };
  });
}

export type PermissionRow = {
  tool: string;
  source: "persisted" | "pre-approved";
  removable: boolean;
};

export function decidePermissionsOpen(
  configDir: string,
  worktree: string,
  onWarning?: (message: string) => void,
): PermissionRow[] {
  const grants = loadGrants(configDir, worktree, onWarning);
  const rows: PermissionRow[] = [];
  for (const tool of PERSISTABLE_TOOL_NAMES) {
    if (grants.project.includes(tool)) {
      rows.push({ tool, source: "persisted", removable: true });
    } else if (grants.global.includes(tool)) {
      rows.push({ tool, source: "pre-approved", removable: false });
    }
  }
  return rows;
}

export function decideEffortOpen(
  catalog: ModelCatalog,
  configDir: string,
  session: SessionState<ModelMessage>,
  plan: Plan | null,
): { tiers: string[]; selected: number } | null {
  const route = resolveSessionRoute(
    session,
    catalog,
    configuredProviders(configDir),
    plan,
    configDir,
  );
  const tiers = resolveLegalReasoningTiers(route, catalog);
  if (tiers.length === 0) return null;
  const current = resolveReasoningEffort(session, loadConfig(configDir));
  const selected = Math.max(0, tiers.indexOf(current ?? ""));
  return { tiers, selected };
}

export function decideMaxTurns(args: string[]): number {
  const raw = args[0];
  if (args.length !== 1 || raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new Error("Usage: /max-turns <N>, where N is a positive integer");
  }
  return Number(raw);
}

export function decideTrajectoryCommand(
  args: string[],
  currentlyEnabled: boolean,
): { enabled?: boolean; message: string } {
  if (args.length === 0) {
    return {
      message: currentlyEnabled ? "Trajectory recording is on." : "Trajectory recording is off.",
    };
  }
  if (args.length !== 1 || (args[0] !== "on" && args[0] !== "off")) {
    throw new Error("Usage: /trajectory [on|off]");
  }
  const enabled = args[0] === "on";
  return {
    enabled,
    message: enabled ? "Trajectory recording is on." : "Trajectory recording is off.",
  };
}

// Validates and returns the directory path without creating it; reject default because profileDir folds that name onto the base config dir, including case-insensitive matches on win32/darwin.
export function decideProfileCreate(args: string[]): { dir: string; name: string } {
  const [subcommand, name] = args;
  if (subcommand !== "new" || name === undefined || args.length !== 2) {
    throw new Error("Usage: /profile new <name>");
  }
  const error = profileNameError(name);
  if (error !== undefined) throw new Error(error);
  if (isDefaultProfile(name)) {
    throw new Error(`"${name}" is already the default profile — there is nothing to create`);
  }
  return { dir: profileDir(name), name };
}

// onPlan runs synchronously before the restore/remove pass.
export function decideUndo(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  onPlan: (plan: RestorePlan) => void = () => {},
): { next: SessionState<ModelMessage>; plan: RestoreResult; message: string } {
  const stepCount = steps(args);
  const plan = undoFiles({
    ...checkpointTarget(session, dirs),
    sessionId: session.id,
    steps: stepCount,
    onPlan,
  });
  const message =
    plan.restored.length === 0 && plan.deleted.length === 0
      ? plan.preserved.length === 0
        ? `Already at checkpoint ${stepCount}; no file changed.`
        : `Already at checkpoint ${stepCount}; no file restored or deleted, but ${plan.preserved.length} file(s) preserved (no proof seri wrote them, or edited since).`
      : `Undid to checkpoint ${stepCount}.`;
  return { next: session, plan, message };
}

export function decideRestore(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  onPlan: (plan: RestorePlan) => void = () => {},
): { next: SessionState<ModelMessage>; plan: RestoreResult; message: string } {
  const commit = args[0] ?? "";
  const plan = restoreCommit({
    ...checkpointTarget(session, dirs),
    sessionId: session.id,
    commit,
    onPlan,
  });
  const message =
    plan.restored.length === 0 && plan.deleted.length === 0
      ? plan.preserved.length === 0
        ? `Already at ${commit}; no file changed.`
        : `Already at ${commit}; no file restored or deleted, but ${plan.preserved.length} file(s) preserved (no proof seri wrote them, or edited since).`
      : `Restored ${commit}.`;
  return { next: session, plan, message };
}

export function decideRewind(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
): { next: SessionState<ModelMessage>; message: string; recordBarrier: () => boolean } {
  const { storeDir } = checkpointTarget(session, dirs);
  const { rewindTo } = rewindConversation({ storeDir, sessionId: session.id, steps: steps(args) });
  const kept = Math.min(rewindTo, session.messages.length);
  const dropped = session.messages.length - kept;
  const next = { ...session, messages: session.messages.slice(0, kept) };
  const recordBarrier = (): boolean => {
    if (dropped === 0) return false;
    appendBarrier(storeDir, session.id, "rewind");
    return true;
  };
  return {
    next,
    message: `Session ${next.id}: dropped ${dropped} message(s), ${kept} remain. No file was touched.`,
    recordBarrier,
  };
}

export function decideClear(
  session: SessionState<ModelMessage>,
  configDir: string,
  newId: string = randomUUID(),
  loadAgents: typeof loadAgentsFile = loadAgentsFile,
  loadExtensions: (cwd: string) => {
    skills: SkillRegistry;
    rules: RuleRegistry;
    hooks: HooksLoad;
  } = (cwd) => ({
    skills: loadSkillRegistry({ worktree: cwd, configDir, onWarning: () => {} }),
    rules: loadRuleRegistry({ worktree: cwd, configDir, onWarning: () => {} }),
    hooks: loadHookRegistry({ worktree: cwd, configDir, onWarning: () => {} }),
  }),
): { next: SessionState<ModelMessage>; message: string } {
  const extensions = loadExtensions(session.cwd);
  const next = {
    ...session,
    id: newId,
    messages: [],
    systemPrompt: buildSystemPrompt({
      agentsContent: loadAgents(session.cwd),
      skills: [...extensions.skills.values()],
      rules: [...extensions.rules.values()],
    }),
  };
  const message = `Started a new session ${next.id}. The previous session is saved — resume it with: seri --resume ${session.id}`;
  return { next, message };
}
