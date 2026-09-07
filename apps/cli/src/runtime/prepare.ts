import { randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import {
  findCatalogEntry,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
} from "@seri/model-catalog";
import type { Plan } from "@seri/plans";
import type { LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { loadAgentsFile as loadAgentsFileReal } from "../agents/loadAgentsFile";
import { buildSystemPrompt } from "../agents/systemPrompt";
import { effectiveHostedPlan, hostedPlanUsable } from "../auth/seriIgnore";
import { type Checkpointer, createCheckpointer } from "../checkpoint/checkpoint";
import { withCheckpoints } from "../checkpoint/wrapTools";
import type { CliDeps, RunContext } from "../cli";
import { pendingQueueNotice, printPreApproved, printWarning } from "../cli/output";
import { loadTrajectoryConfig, loadVerifyConfig, type VerifyConfig } from "../config/config";
import { getConfigDir, getTrajectoriesDir } from "../config/paths";
import { messageOf } from "../errors";
import {
  classifyToolCall as allowAllClassifier,
  type AutoModeOnBlock,
  type ToolCallClassifier,
} from "../gate/classifier";
import type { Consent } from "../gate/fsBoundary";
import type { PathDenial, PermissionMode } from "../gate/gate";
import { type HooksLoad, loadHookRegistry } from "../hooks/registry";
import {
  closeMcpClients,
  createMcpClients,
  createSessionDial,
  type McpClients,
} from "../mcp/client";
import { grantFingerprint, loadMcpRegistry } from "../mcp/registry";
import {
  isMcpToolName,
  type McpEntry,
  type McpRegistry,
  mcpGrantMatches,
  parseMcpGrantKey,
} from "../mcp/types";
import { type ArchivistState, createArchivistState } from "../memory/archivist";
import { listPending } from "../memory/pending";
import { type LoadedMemory, loadMemory } from "../memory/store";
import { effectiveTools, loadAutoModeOnBlock, loadDenials, loadGrants } from "../permissions/store";
import { fetchAccountPlan } from "../provider/accountStatus";
import { getModelCatalog } from "../provider/catalog";
import { DEFAULT_PROVIDER, resolveDefaultModel } from "../provider/defaults";
import { configuredProviders, PROVIDER_DISPLAY_NAMES } from "../provider/keys";
import { dispatchModel } from "../provider/model";
import { appliedReasoningEffort } from "../provider/reasoning";
import { type ResolvedRoute, type RouteCredential, resolveRoute } from "../provider/routing";
import { subscribedProviders } from "../provider/subscriptions";
import { createToolDefinitions } from "../provider/tools";
import { createRulesState, type RulesState } from "../rules/match";
import { loadRuleRegistry, type RuleRegistry } from "../rules/registry";
import { configDirForStore, type SessionDatabase } from "../session/database";
import {
  findMostRecentSession,
  loadSession,
  type SessionState,
  saveSession,
} from "../session/session";
import { listPendingSkills } from "../skills/pending";
import { loadSkillRegistry, type SkillRegistry } from "../skills/registry";
import { type AgentRegistry, loadAgentRegistry } from "../subagents/registry";
import { buildRunManifest, collectContextFiles } from "../trajectory/manifest";
import { createTrajectoryWriter, type TrajectoryWriter } from "../trajectory/writer";
import { destroyTuiRenderer } from "../tui/runtime/renderer";
import { type CommandDirs, checkpointTarget } from "../tui/state/commands";
import { withVerification } from "../verify/wrapTools";

export async function resolveModelRoute(
  requested: { model: string; provider: ModelProvider | undefined },
  configDir: string,
  sessionId: string,
  deps: CliDeps,
  warnSink?: (text: string) => void,
): Promise<{
  model: LanguageModel;
  route: ResolvedRoute;
  catalog: ModelCatalog;
  plan: Plan | null;
}> {
  const configured = configuredProviders(configDir);
  const requestedProvider =
    requested.provider ?? resolveDefaultModel(configDir).provider ?? DEFAULT_PROVIDER;
  const [catalog, plan] = await Promise.all([
    getModelCatalog(undefined, warnSink, configDir),
    fetchAccountPlan(configDir),
  ]);
  const route = resolveRoute(
    catalog,
    { model: requested.model, provider: requestedProvider },
    configured,
    effectiveHostedPlan(configDir, plan),
    subscribedProviders(configDir),
    hostedPlanUsable(configDir),
  );
  const model = dispatchModel(route, sessionId, configDir, deps);
  return { model, route, catalog, plan };
}

export type RunSession = SessionState<ModelMessage> & {
  model: string;
  provider: ModelProvider | undefined;
};

export function loadOrCreateSession(
  resuming: boolean,
  resumeId: string | undefined,
  sessionsDir: string,
  loadAgentsFileFn: typeof loadAgentsFileReal,
  configDir: string,
  cwd: string,
  loadExtensions: (cwd: string) => { skills: SkillRegistry; rules: RuleRegistry; hooks: HooksLoad },
  onTruncated: () => void = () => {},
  database?: SessionDatabase,
): {
  session: RunSession;
  modelRecorded: boolean;
  skills: SkillRegistry;
  rules: RuleRegistry;
  hooks: HooksLoad;
} {
  if (resuming) {
    const id = resumeId ?? findMostRecentSession(sessionsDir, database);
    if (!id) throw new Error("No session to resume.");
    const loaded = loadSession<ModelMessage>(id, sessionsDir, onTruncated, database);
    const { model, provider } =
      loaded.model === undefined
        ? resolveDefaultModel(configDir)
        : { model: loaded.model, provider: loaded.provider };
    const { skills, rules, hooks } = loadExtensions(loaded.cwd);
    return {
      session: {
        ...loaded,
        systemPrompt: buildSystemPrompt({
          agentsContent: loadAgentsFileFn(loaded.cwd),
          skills: [...skills.values()],
          rules: [...rules.values()],
        }),
        model,
        provider,
      },
      modelRecorded: loaded.model !== undefined,
      skills,
      rules,
      hooks,
    };
  }

  const { model, provider } = resolveDefaultModel(configDir);
  const { skills, rules, hooks } = loadExtensions(cwd);
  return {
    session: {
      id: randomUUID(),
      cwd,
      systemPrompt: buildSystemPrompt({
        agentsContent: loadAgentsFileFn(cwd),
        skills: [...skills.values()],
        rules: [...rules.values()],
      }),
      // On native Windows the OS sandbox is not enforced, so the default permission mode is approve-each.
      permissionMode: "approve-each",
      model,
      provider,
      messages: [],
    },
    modelRecorded: false,
    skills,
    rules,
    hooks,
  };
}

export function dirs(ctx: RunContext, trajectory?: TrajectoryWriter): CommandDirs {
  return {
    sessionsDir: ctx.sessionsDir,
    checkpointsDir: ctx.checkpointsDir,
    configDir: ctx.configDir,
    ...(trajectory !== undefined ? { trajectory } : {}),
  };
}

export function createSessionTrajectory(
  session: { id: string; cwd: string; model?: string; provider?: string },
  configDir: string,
  onWarning: (message: string) => void,
  database?: SessionDatabase,
  extras?: {
    contextFiles?: () => readonly string[];
    provider?: ModelProvider;
    credential?: RouteCredential;
  },
): TrajectoryWriter {
  const cfg = loadTrajectoryConfig(configDir);
  const trajectoriesDir = getTrajectoriesDir(configDir);
  const held =
    database !== undefined &&
    database.configDir === configDirForStore(trajectoriesDir, "trajectories")
      ? database
      : undefined;
  return createTrajectoryWriter({
    dir: trajectoriesDir,
    sessionId: session.id,
    cwd: session.cwd,
    model: session.model,
    provider: session.provider,
    enabled: cfg.enabled,
    retentionDays: cfg.retentionDays,
    onWarning,
    ...(held !== undefined ? { database: held } : {}),
    manifest: () =>
      buildRunManifest({
        cwd: session.cwd,
        configDir,
        provider: extras?.provider,
        credential: extras?.credential,
        contextFiles: extras?.contextFiles?.(),
        maxIterations: 500,
      }),
  });
}

export type RunStart = "idle" | "task" | "resume";

export function runStart(ctx: RunContext): RunStart {
  if (ctx.taskText.length > 0) return "task";
  return ctx.resuming ? "resume" : "idle";
}

export type PreMountMessage = { text: string; stream: "stdout" | "stderr" };

export type PreparedRun = {
  session: RunSession;
  storeDir: string;
  tools: ToolSet;
  model: LanguageModel;
  permissionMode: PermissionMode;
  outsideConsent?: { current: Consent };
  worktree: string;
  allowedTools: readonly string[];
  autoModeOnBlock?: AutoModeOnBlock;
  classifyToolCall?: ToolCallClassifier;
  pathDenials: readonly PathDenial[];
  catalog: ModelCatalog;
  catalogEntry: ModelCatalogEntry | undefined;
  route: ResolvedRoute;
  plan: Plan | null;
  checkpointer: Checkpointer;
  verifyConfig: VerifyConfig;
  memory: LoadedMemory;
  agents: AgentRegistry;
  skills: SkillRegistry;
  rules: RuleRegistry;
  rulesState: RulesState;
  hooks: HooksLoad;
  mcp: Map<string, McpEntry>;
  mcpClients: McpClients;
  trajectory: TrajectoryWriter;
  database?: SessionDatabase;
  preMountMessages: PreMountMessage[];
};

export function rerouteNotice(
  route: ResolvedRoute,
  requestedProvider: ModelProvider | undefined,
): string {
  if (requestedProvider === undefined) {
    return `routing ${route.model} via ${route.provider} (your key)`;
  }
  return `routing ${route.model} via ${route.provider} (your key) — no ${PROVIDER_DISPLAY_NAMES[requestedProvider]} key configured`;
}

export function gatewayNotice(
  route: ResolvedRoute,
  requestedProvider: ModelProvider | undefined,
): string {
  const head = `routing ${route.model} on your seri plan`;
  if (requestedProvider === undefined || requestedProvider === route.provider) {
    return head;
  }
  return `${head} — no ${PROVIDER_DISPLAY_NAMES[requestedProvider]} key configured`;
}

export function fatalDuringTui(
  err: unknown,
  preMountMessages: readonly PreMountMessage[] = [],
): number {
  destroyTuiRenderer();
  for (const queued of preMountMessages) {
    (queued.stream === "stdout" ? console.log : console.error)(queued.text);
  }
  console.error(messageOf(err));
  return 1;
}

export function buildCheckpointedTools(opts: {
  storeDir: string;
  worktree: string;
  sessionId: string;
  cwd: string;
  verifyConfig: VerifyConfig;
  onWarning: (message: string) => void;
  onCheckpoint?: (entry: { op: "snapshot"; tool: string; toolCallId: string }) => void;
}): { checkpointer: Checkpointer; tools: ToolSet } {
  const live = createCheckpointer(opts);
  const checkpointer = Object.assign(
    (context: Parameters<Checkpointer>[0]) => {
      live(context);
      opts.onCheckpoint?.({ op: "snapshot", tool: context.tool, toolCallId: context.toolCallId });
    },
    { onAfterMutation: live.onAfterMutation, invalidate: live.invalidate },
  );
  const tools = withVerification(
    withCheckpoints(createToolDefinitions(opts.cwd), checkpointer, checkpointer.onAfterMutation),
    opts.verifyConfig,
  );
  return { checkpointer, tools };
}

/** Skills and agents load separately, so a shared name is warned here; `/name` dispatches the agent. */
export function warnOnNameCollisions(
  skills: SkillRegistry,
  agents: AgentRegistry,
  onWarning: (message: string) => void,
): void {
  for (const name of skills.keys()) {
    if (agents.has(name)) {
      onWarning(
        `"${name}" names both an agent and a skill; /${name} runs the agent. The skill is still reachable through the skill tool.`,
      );
    }
  }
}

function filterMcpGrants(
  entries: readonly string[],
  registry: McpRegistry,
  onWarning: (message: string) => void,
): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    if (!isMcpToolName(entry)) {
      result.push(entry);
      continue;
    }
    const parsed = parseMcpGrantKey(entry);
    if (parsed === undefined) continue;
    const fingerprint = grantFingerprint(registry, parsed.toolName);
    if (fingerprint !== undefined && mcpGrantMatches(entry, fingerprint)) {
      result.push(parsed.toolName);
    } else {
      onWarning(
        `the saved approval for "${parsed.toolName}" no longer matches this server's current tool, so you will be asked again`,
      );
    }
  }
  return result;
}

export function bindSession(
  prepared: PreparedRun,
  session: RunSession,
  configDir: string,
  permissionsDir: string,
  onWarning: (message: string) => void,
): ArchivistState {
  const trajectory = createSessionTrajectory(session, configDir, onWarning, prepared.database, {
    contextFiles: () =>
      collectContextFiles({
        cwd: session.cwd,
        rules: prepared.rules.values(),
        skills: prepared.skills.values(),
      }),
    provider: prepared.route.provider,
    credential: prepared.route.credential,
  });
  const { checkpointer, tools } = buildCheckpointedTools({
    storeDir: prepared.storeDir,
    worktree: prepared.worktree,
    sessionId: session.id,
    cwd: session.cwd,
    verifyConfig: prepared.verifyConfig,
    onWarning,
    onCheckpoint: (entry) => trajectory.recordCheckpoint(entry),
  });
  prepared.checkpointer = checkpointer;
  prepared.tools = tools;
  prepared.memory = loadMemory({ configDir, worktree: prepared.worktree });
  prepared.skills = loadSkillRegistry({ worktree: session.cwd, configDir, onWarning });
  prepared.rules = loadRuleRegistry({ worktree: session.cwd, configDir, onWarning });
  prepared.rulesState = createRulesState();
  prepared.hooks = loadHookRegistry({ worktree: session.cwd, configDir, onWarning });
  prepared.agents = loadAgentRegistry({
    worktree: prepared.worktree,
    configDir,
    catalog: prepared.catalog,
    onWarning,
  });
  warnOnNameCollisions(prepared.skills, prepared.agents, onWarning);
  closeMcpClients(prepared.mcpClients, onWarning);
  prepared.mcp = loadMcpRegistry({ worktree: prepared.worktree, configDir, onWarning });
  prepared.mcpClients = createMcpClients(createSessionDial(configDir));
  const grants = loadGrants(permissionsDir, prepared.worktree, onWarning);
  prepared.allowedTools = filterMcpGrants(effectiveTools(grants), prepared.mcp, onWarning);
  prepared.pathDenials = loadDenials(permissionsDir, onWarning);
  prepared.autoModeOnBlock = loadAutoModeOnBlock(permissionsDir, onWarning);
  prepared.session = session;
  prepared.trajectory = trajectory;
  return createArchivistState(session);
}

const UNTRUSTED_HOOK_FILES_SHOWN = 3;

function untrustedHooksNotice(untrusted: NonNullable<HooksLoad["untrusted"]>): string {
  const where = `project hooks in ${untrusted.dir}`;
  if (untrusted.verdict.kind === "changed") {
    const { files } = untrusted.verdict;
    const shown = files.slice(0, UNTRUSTED_HOOK_FILES_SHOWN).join(", ");
    const rest = files.length - UNTRUSTED_HOOK_FILES_SHOWN;
    return `${where} changed since you trusted them (${rest > 0 ? `${shown} and ${rest} more` : shown}), so none of them ran — /hooks to review what moved`;
  }
  return `${where} (${untrusted.scriptCount} files) have not been reviewed, so none of them ran — /hooks to read them and turn them on`;
}

export async function prepareSession(
  ctx: RunContext,
  deps: CliDeps,
  skipPermissions: boolean,
  isTTY: boolean,
): Promise<PreparedRun | number> {
  const loadAgentsFileFn = deps.loadAgentsFile ?? loadAgentsFileReal;
  const preMountMessages: PreMountMessage[] = [];
  const emit = isTTY
    ? (text: string) => preMountMessages.push({ text, stream: "stdout" })
    : console.log;
  const warn = isTTY
    ? (text: string) => preMountMessages.push({ text, stream: "stderr" })
    : console.error;
  const warnSink = isTTY ? warn : undefined;

  try {
    const configDir = deps.authConfigDir ?? getConfigDir();
    const { session, modelRecorded, skills, rules, hooks } = loadOrCreateSession(
      ctx.resuming,
      ctx.resumeId,
      ctx.sessionsDir,
      loadAgentsFileFn,
      configDir,
      ctx.cwd,
      (cwd) =>
        deps.loadExtensions?.(cwd, configDir) ?? {
          skills: loadSkillRegistry({
            worktree: cwd,
            configDir,
            onWarning: (msg) => printWarning(msg, warnSink),
          }),
          rules: loadRuleRegistry({
            worktree: cwd,
            configDir,
            onWarning: (msg) => printWarning(msg, warnSink),
          }),
          hooks: loadHookRegistry({
            worktree: cwd,
            configDir,
            onWarning: (msg) => printWarning(msg, warnSink),
          }),
        },
      () =>
        printWarning(
          "the last message in this session's saved history was incomplete (an interrupted save) and has been dropped — everything before it is intact",
          warnSink,
        ),
      ctx.database,
    );

    if (!ctx.resuming) emit(`Session ${session.id} created.`);

    if (hooks.untrusted !== undefined) {
      printWarning(untrustedHooksNotice(hooks.untrusted), warnSink);
    }

    const queueNotice = pendingQueueNotice(
      listPending(configDir, (msg) => printWarning(msg, warnSink)).length,
      listPendingSkills(configDir, (msg) => printWarning(msg, warnSink)).length,
    );
    if (queueNotice !== undefined) emit(queueNotice);

    if (runStart(ctx) === "task") {
      session.messages.push({ role: "user", content: ctx.taskText });
    }

    const { model, route, catalog, plan } = await resolveModelRoute(
      { model: session.model, provider: session.provider },
      configDir,
      session.id,
      deps,
      warnSink,
    );
    if (route.rerouted && !isTTY) {
      printWarning(rerouteNotice(route, session.provider));
    } else if (route.credential === "gateway" && !isTTY) {
      printWarning(gatewayNotice(route, session.provider));
    }
    const catalogEntry = findCatalogEntry(catalog, route.model, route.provider);
    if (
      session.reasoningEffort !== undefined &&
      appliedReasoningEffort(session.reasoningEffort, catalogEntry) === undefined &&
      !isTTY
    ) {
      printWarning(
        `reasoning effort "${session.reasoningEffort}" isn't legal for the current model — this turn runs without it.`,
      );
    }

    saveSession(
      modelRecorded ? session : { ...session, model: undefined },
      ctx.sessionsDir,
      ctx.database,
    );

    const { storeDir, worktree } = checkpointTarget(session, dirs(ctx));

    const mcp = loadMcpRegistry({
      worktree,
      configDir,
      onWarning: (msg) => printWarning(msg, warnSink),
    });
    const mcpClients = createMcpClients(createSessionDial(configDir));

    const grants = loadGrants(ctx.permissionsDir, worktree, (msg) => printWarning(msg, warnSink));
    const allowedTools = filterMcpGrants(effectiveTools(grants), mcp, (msg) =>
      printWarning(msg, warnSink),
    );
    const pathDenials = loadDenials(ctx.permissionsDir, (msg) => printWarning(msg, warnSink));
    const permissionMode = skipPermissions ? "auto" : session.permissionMode;
    const loadedAutoModeOnBlock = loadAutoModeOnBlock(ctx.permissionsDir, (msg) =>
      printWarning(msg, warnSink),
    );
    const autoModeOnBlock = isTTY ? loadedAutoModeOnBlock : "deny";
    if (permissionMode === "approve-each" && allowedTools.length > 0) {
      printPreApproved(allowedTools, isTTY ? emit : undefined);
    }

    const inProject = relative(worktree, session.cwd);
    if (inProject === ".." || inProject.startsWith(`..${sep}`) || isAbsolute(inProject)) {
      printWarning(
        `this session's files are checkpointed under ${worktree}, but tools run in ${session.cwd} — /undo will act on ${worktree}`,
        warnSink,
      );
    }

    const verifyConfig = loadVerifyConfig(configDir);
    const trajectory = createSessionTrajectory(
      session,
      configDir,
      (msg) => printWarning(msg, warnSink),
      ctx.database,
      {
        contextFiles: () =>
          collectContextFiles({ cwd: session.cwd, rules: rules.values(), skills: skills.values() }),
        provider: route.provider,
        credential: route.credential,
      },
    );
    const { checkpointer, tools } = buildCheckpointedTools({
      storeDir,
      worktree,
      sessionId: session.id,
      cwd: session.cwd,
      verifyConfig,
      onWarning: (msg) => printWarning(msg, warnSink),
      onCheckpoint: (entry) => trajectory.recordCheckpoint(entry),
    });

    const memory = loadMemory({ configDir, worktree });

    const agents = loadAgentRegistry({
      worktree,
      configDir,
      catalog,
      onWarning: (msg) => printWarning(msg, warnSink),
    });

    warnOnNameCollisions(skills, agents, (msg) => printWarning(msg, warnSink));

    return {
      session,
      storeDir,
      tools,
      model,
      permissionMode,
      outsideConsent: { current: skipPermissions ? "allowed-this-run" : "unasked" },
      worktree,
      allowedTools,
      pathDenials,
      autoModeOnBlock,
      classifyToolCall: skipPermissions ? undefined : allowAllClassifier,
      catalog,
      catalogEntry,
      route,
      plan,
      checkpointer,
      verifyConfig,
      memory,
      agents,
      skills,
      rules,
      rulesState: createRulesState(),
      hooks,
      mcp,
      mcpClients,
      trajectory,
      database: ctx.database,
      preMountMessages,
    };
  } catch (err) {
    return fatalDuringTui(err, preMountMessages);
  }
}
