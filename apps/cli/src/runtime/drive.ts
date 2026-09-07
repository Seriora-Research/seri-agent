import { randomUUID } from "node:crypto";
import { findCatalogEntry, type ModelProvider } from "@seri/model-catalog";
import type { LanguageModel, LanguageModelUsage, ModelMessage } from "ai";
import { buildVolatileTier, joinTiers } from "../agents/systemPrompt";
import { appendBarrier } from "../checkpoint/checkpoint";
import type { CliDeps, PreparedRun, RunContext } from "../cli";
import { printGrantPersisted, printWarning, type RunUsage } from "../cli/output";
import {
  BLOCK_READS_OUTSIDE_WORKING_DIRECTORIES_KEY,
  configValue,
  loadConfig,
  standingDenyReadsOutside,
} from "../config/config";
import { loadContainmentExpected } from "../containment/escape";
import { loadSamplingConfig } from "../provider/sampling";
import { messageOf } from "../errors";
import type { PermissionMode } from "../gate/gate";
import { createHookRunner } from "../hooks/gate";
import { type ApprovalPrompt, type LoopEvent, runLoop as runLoopReal } from "../loop/loop";
import { grantFingerprint } from "../mcp/registry";
import { mcpCallSubject, withMcp } from "../mcp/tool";
import {
  type ArchivistReport,
  type ArchivistState,
  maybeRunArchivist,
  observeArchivistEvent,
} from "../memory/archivist";
import { rememberGrant } from "../permissions/store";
import type { CostReport } from "../provider/cost";
import { effectiveHostedPlan, hostedPlanUsable } from "../auth/seriIgnore";
import { configuredProviders } from "../provider/keys";
import { dispatchModel } from "../provider/model";
import { resolveReasoningEffort } from "../provider/reasoning";
import { subscribedProviders } from "../provider/subscriptions";
import { DISPATCH_TOOL_NAME } from "../provider/tools";
import { createRuleInjector } from "../rules/match";
import type { SessionState } from "../session/session";
import { onSignalCancel } from "../signals";
import { withSkills } from "../skills/tool";
import { ASK_USER_OVERLAY } from "../ask-user/prompt";
import { withAskUser } from "../ask-user/tool";
import type { AskUserPresenter } from "../ask-user/types";
import { withTodo } from "../todo/tool";
import { PLAN_MODE_OVERLAY } from "../plan/prompt";
import {
  isSubmittedPlan,
  type PlanAnswers,
  type PlanQuestion,
  type SubmittedPlan,
} from "../plan/mode";
import { SUBMIT_PLAN_TOOL_NAME, stripWriteTools, withPlanTools } from "../plan/tools";
import { type ChildEventPayload, dispatchDirect, withSubagents } from "../subagents/dispatch";
import type { AgentSpec } from "../subagents/registry";
import {
  effortForChild,
  isRoutableRole,
  parseRolePins,
  pinFromTask,
  realizedRoute,
  resolveChildRoute,
  roleConstructionWarning,
  type TaskRouteRequest,
} from "../subagents/routes";

type DoneReason = Extract<LoopEvent, { type: "done" }>["reason"];

export function addTokens(
  total: number | undefined,
  reported: number | undefined,
): number | undefined {
  return reported === undefined ? total : (total ?? 0) + reported;
}

const COST_STATUS_RANK: Record<CostReport["status"], number> = {
  unknown: 0,
  estimated: 1,
  included: 2,
  actual: 2,
};
export function addCost(
  total: CostReport | undefined,
  next: CostReport | undefined,
): CostReport | undefined {
  if (next === undefined) return total;
  if (total === undefined) return next;
  const weaker = COST_STATUS_RANK[total.status] <= COST_STATUS_RANK[next.status] ? total : next;
  return {
    amountUsd: addTokens(total.amountUsd, next.amountUsd),
    status: weaker.status,
    source: weaker.source,
  };
}

export type DriveLoopResult = {
  doneReason: DoneReason | undefined;
  cancelledBy: NodeJS.Signals | undefined;
  usage: RunUsage;
  cost: CostReport | undefined;
  refusedWithoutRunning: boolean;
  archivist: ArchivistReport | undefined;
  directSummary: string | undefined;
  ranAnyTurn: boolean;
  submittedPlan?: SubmittedPlan;
};

export type DriveLoopOptions = {
  signal?: AbortSignal;
  bindProcessCancel?: boolean;
  composeSubagents?: boolean;
  runArchivist?: boolean;
  directDispatch?: { agent: AgentSpec; goal: string };
  planMode?: {
    askQuestions: (
      questions: readonly PlanQuestion[],
      signal?: AbortSignal,
    ) => Promise<PlanAnswers>;
    configDir: string;
  };
  askUser?: AskUserPresenter;
  composeAskUser?: boolean;
  askOutsideFs?: boolean;
};

export function exitCodeFromDriveResult(result: DriveLoopResult): 0 | 1 {
  if (!result.ranAnyTurn) return 0;
  if (result.doneReason === "no-tool-call") return result.refusedWithoutRunning ? 1 : 0;
  if (result.doneReason === "plan-submitted") return 0;
  return 1;
}

// makeApprovalPrompt opens readline on stdin and a second SIGINT route; Ink already owns raw mode, so the TUI must pass a different ApprovalPrompt.
export async function driveLoop(
  prepared: PreparedRun,
  ctx: RunContext,
  deps: CliDeps,
  maxTurns: number | undefined,
  onEvent: (event: LoopEvent) => void,
  getPermissionMode: () => PermissionMode,
  persist: (session: SessionState<ModelMessage>) => void,
  approvalPrompt: ApprovalPrompt | undefined,
  archivistState: ArchivistState,
  onChildEvent?: (payload: ChildEventPayload) => void,
  driveOpts: DriveLoopOptions = {},
): Promise<DriveLoopResult> {
  const {
    session,
    storeDir,
    tools: baseTools,
    model,
    worktree,
    allowedTools,
    pathDenials,
    catalog,
    catalogEntry,
    route,
    checkpointer,
    memory,
  } = prepared;
  const runLoopFn = deps.runLoop ?? runLoopReal;
  const config = loadConfig(ctx.configDir);
  const reasoningEffort = resolveReasoningEffort(session, config);
  const samplingConfig = loadSamplingConfig(ctx.configDir);
  const standingDeny = standingDenyReadsOutside(
    configValue(BLOCK_READS_OUTSIDE_WORKING_DIRECTORIES_KEY, config),
  );
  const askOutsideFs = driveOpts.askOutsideFs !== false;
  if (prepared.outsideConsent === undefined) {
    prepared.outsideConsent = { current: "unasked" };
  }
  prepared.trajectory.setStepCeiling(maxTurns ?? 500);

  const controller = new AbortController();
  let cancelledBy: NodeJS.Signals | undefined;
  if (driveOpts.signal?.aborted) controller.abort();
  else {
    driveOpts.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const unregisterCancel =
    driveOpts.bindProcessCancel === false
      ? () => {}
      : onSignalCancel((signal) => {
          cancelledBy = signal;
          controller.abort();
        });

  let doneReason: DoneReason | undefined;
  const usage: RunUsage = { inputTokens: undefined, outputTokens: undefined };
  let cost: CostReport | undefined;
  const system = joinTiers(
    session.systemPrompt,
    buildVolatileTier(route.model, route.provider, catalogEntry?.displayName, memory, {
      family: catalogEntry?.family ?? null,
    }),
  );
  const askUserEnabled = driveOpts.composeAskUser !== false;
  const parentSystem = joinTiers(
    system,
    driveOpts.planMode === undefined ? undefined : PLAN_MODE_OVERLAY,
    askUserEnabled ? ASK_USER_OVERLAY : undefined,
  );
  const pins = parseRolePins(process.env, config);
  const configured = configuredProviders(ctx.configDir);
  type RoleOverlay = {
    model: LanguageModel;
    provider: ModelProvider;
    modelId: string;
    contextWindowSize: number | undefined;
    reasoningEffort: string | undefined;
    inherited: boolean;
    credential: typeof route.credential;
  };
  const roleOverlays = new Map<string, RoleOverlay>();
  function overlayKey(role: string, request: TaskRouteRequest | undefined): string {
    const pin = pinFromTask(request);
    const effort =
      typeof request?.effort === "string" && request.effort.length > 0 ? request.effort : "";
    if (pin === undefined && effort.length === 0) return role;
    return `${role}:${pin?.provider ?? ""}:${pin?.model ?? ""}:${effort}`;
  }
  function overlayFor(role: string, request?: TaskRouteRequest): RoleOverlay {
    const key = overlayKey(role, request);
    const cached = roleOverlays.get(key);
    if (cached !== undefined) return cached;
    const intended = resolveChildRoute(
      isRoutableRole(role) ? role : undefined,
      route,
      pins,
      request,
      catalog,
      configured,
      effectiveHostedPlan(ctx.configDir, prepared.plan),
      subscribedProviders(ctx.configDir),
      hostedPlanUsable(ctx.configDir),
    );
    const samePair = intended.model === route.model && intended.provider === route.provider;
    let childModel = model;
    let constructed = intended.inherited || samePair;
    if (!constructed) {
      try {
        childModel = dispatchModel(
          {
            model: intended.model,
            provider: intended.provider,
            rerouted: intended.rerouted,
            credential: intended.credential,
          },
          session.id,
          ctx.configDir,
          deps,
        );
        constructed = true;
      } catch (err) {
        printWarning(roleConstructionWarning(role, intended, messageOf(err)));
        constructed = false;
      }
    }
    const actual = realizedRoute(intended, route, constructed);
    const overlay: RoleOverlay = {
      model: actual.inherited ? model : childModel,
      provider: actual.provider,
      modelId: actual.model,
      contextWindowSize: actual.inherited
        ? catalogEntry?.contextWindow
        : findCatalogEntry(catalog, actual.model, actual.provider)?.contextWindow,
      reasoningEffort: effortForChild(
        { provider: route.provider, modelId: route.model, reasoningEffort },
        { provider: actual.provider, modelId: actual.model },
        request?.effort,
      ),
      inherited: actual.inherited,
      credential: actual.credential,
    };
    roleOverlays.set(key, overlay);
    return overlay;
  }
  const hookRunner = createHookRunner({
    registry: prepared.hooks.registry,
    cwd: session.cwd,
    signal: controller.signal,
  });
  const containmentEscapeExpected = loadContainmentExpected(config);
  const subagentRuntime = {
    runLoop: runLoopFn,
    model,
    provider: route.provider,
    modelId: route.model,
    credential: route.credential,
    temperature: samplingConfig.temperature,
    seed: samplingConfig.seed,
    catalog,
    contextWindowSize: catalogEntry?.contextWindow,
    system,
    agents: prepared.agents,
    permissionMode: getPermissionMode,
    allowedTools,
    pathDenials,
    checkpointer,
    reasoningEffort,
    cwd: worktree,
    blockReadsOutsideWorkingDirectories: standingDeny,
    outsideConsent: prepared.outsideConsent,
    onBeforeTool: hookRunner?.onBeforeTool,
    onAfterTool: hookRunner?.onAfterTool,
    containmentEscapeExpected,
    classifyToolCall: prepared.classifyToolCall,
    autoModeOnBlock: prepared.autoModeOnBlock ?? "deny",
    resolveRole: (role: string, request?: TaskRouteRequest) => overlayFor(role, request),
    onChildUsage: (childUsage: LanguageModelUsage, childCost: CostReport | undefined) => {
      usage.inputTokens = addTokens(usage.inputTokens, childUsage.inputTokens);
      usage.outputTokens = addTokens(usage.outputTokens, childUsage.outputTokens);
      cost = addCost(cost, childCost);
      prepared.trajectory.recordChildUsage(childUsage, childCost);
    },
    onChildEvent: (payload: ChildEventPayload) => {
      prepared.trajectory.recordChildEvent(payload);
      onChildEvent?.(payload);
    },
  };
  const dispatchable =
    driveOpts.composeSubagents === false
      ? baseTools
      : withTodo(withSubagents(baseTools, subagentRuntime));
  const composed = withMcp(
    withSkills(dispatchable, prepared.skills),
    prepared.mcp,
    prepared.mcpClients,
  );
  const withAsk = askUserEnabled ? withAskUser(composed, driveOpts.askUser) : composed;
  const tools =
    driveOpts.planMode === undefined
      ? withAsk
      : withPlanTools(stripWriteTools(withAsk), driveOpts.planMode);
  let hadDenial = false;
  let ranTool = false;
  let archivist: ArchivistReport | undefined;
  let directSummary: string | undefined;
  let submittedPlan: SubmittedPlan | undefined;

  async function* directDispatchEvents(direct: {
    agent: AgentSpec;
    goal: string;
  }): AsyncGenerator<LoopEvent> {
    const toolCallId = randomUUID();
    yield {
      type: "tool-call",
      name: DISPATCH_TOOL_NAME,
      args: { tasks: [{ role: direct.agent.name, goal: direct.goal }] },
    };
    const { result, rows } = await dispatchDirect({
      runtime: subagentRuntime,
      spec: direct.agent,
      goal: direct.goal,
      toolCallId,
      rewindTo: session.messages.length,
      signal: controller.signal,
    });
    directSummary = `[dispatched to the "${direct.agent.name}" subagent]\n\n${result.results[0].summary}`;
    yield { type: "tool-result", name: DISPATCH_TOOL_NAME, result };
    yield { type: "messages-updated", messages: [...session.messages, ...rows] };
    yield { type: "done", reason: controller.signal.aborted ? "aborted" : "no-tool-call" };
  }

  try {
    for await (const event of driveOpts.directDispatch !== undefined
      ? directDispatchEvents(driveOpts.directDispatch)
      : runLoopFn({
          model,
          tools,
          messages: session.messages,
          get permissionMode() {
            return getPermissionMode();
          },
          allowedTools,
          pathDenials,
          cwd: session.cwd,
          callSubject: mcpCallSubject,
          approvalPrompt,
          classifyToolCall: prepared.classifyToolCall,
          autoModeOnBlock: prepared.autoModeOnBlock ?? "deny",
          workingDirectory: session.cwd,
          blockReadsOutsideWorkingDirectories: standingDeny,
          askOutsideFs,
          outsideConsent: prepared.outsideConsent,
          system: parentSystem,
          onToolPhaseEnd: createRuleInjector({
            rules: prepared.rules,
            state: prepared.rulesState,
            worktree: prepared.worktree,
            cwd: session.cwd,
          }),
          onBeforeTool: hookRunner?.onBeforeTool,
          onAfterTool: hookRunner?.onAfterTool,
          containmentEscapeExpected,
          signal: controller.signal,
          maxIterations: maxTurns,
          provider: route.provider,
          modelId: route.model,
          credential: route.credential,
          catalog,
          contextWindowSize: catalogEntry?.contextWindow,
          reasoningEffort,
          temperature: samplingConfig.temperature,
          seed: samplingConfig.seed,
          terminalTools:
            driveOpts.planMode === undefined ? undefined : new Set([SUBMIT_PLAN_TOOL_NAME]),
        })) {
      observeArchivistEvent(archivistState, event);
      prepared.trajectory.recordLoopEvent(event);
      if (event.type === "messages-updated") {
        persist({ ...session, messages: event.messages });
        onEvent(event);
        continue;
      }
      if (event.type === "permission-denied" && event.reason === "declined") hadDenial = true;
      if (event.type === "tool-call") ranTool = true;
      if (
        event.type === "tool-result" &&
        event.name === SUBMIT_PLAN_TOOL_NAME &&
        isSubmittedPlan(event.result)
      ) {
        submittedPlan = event.result;
      }
      if (event.type === "compacted") {
        try {
          appendBarrier(storeDir, session.id, "compaction");
          prepared.trajectory.recordCheckpoint({ op: "compaction-barrier" });
        } catch (err) {
          printWarning(
            `could not record the compaction barrier, so /rewind may not be able to cross this point: ${messageOf(err)}`,
          );
        }
      }
      if (event.type === "usage" || event.type === "compacted") {
        usage.inputTokens = addTokens(usage.inputTokens, event.usage.inputTokens);
        usage.outputTokens = addTokens(usage.outputTokens, event.usage.outputTokens);
      }
      if (event.type === "usage") cost = addCost(cost, event.cost);
      if (event.type === "done") doneReason = event.reason;
      onEvent(event);
      // Hermes #4739: a grant the user believes was saved and was not must warn, not crash the run.
      if (event.type === "tool-allowed") {
        try {
          if (
            rememberGrant(
              ctx.permissionsDir,
              worktree,
              event.name,
              printWarning,
              grantFingerprint(prepared.mcp, event.name),
            )
          )
            printGrantPersisted(event.name, worktree);
        } catch (err) {
          printWarning(
            `could not save the permanent approval for ${event.name}, so seri will ask again next time: ${messageOf(err)}`,
          );
        }
      }
    }

    if (driveOpts.runArchivist !== false) {
      const archivistOverlay = overlayFor("archivist");
      archivist = await maybeRunArchivist({
        state: archivistState,
        ctx: { configDir: ctx.configDir, worktree },
        contextWindow: catalogEntry?.contextWindow,
        model: archivistOverlay.model,
        route: { model: archivistOverlay.modelId, provider: archivistOverlay.provider },
        catalog,
        signal: controller.signal,
        onWarning: printWarning,
        reasoningEffort: archivistOverlay.reasoningEffort,
        onBeforeTool: hookRunner?.onBeforeTool,
        onAfterTool: hookRunner?.onAfterTool,
        containmentEscapeExpected,
        classifyToolCall: prepared.classifyToolCall,
        autoModeOnBlock: prepared.autoModeOnBlock ?? "deny",
      });
      prepared.trajectory.recordArchivist(archivist);
    }
  } finally {
    unregisterCancel();
  }

  return {
    doneReason,
    cancelledBy,
    usage,
    cost,
    refusedWithoutRunning: hadDenial && !ranTool,
    archivist,
    directSummary,
    ranAnyTurn: true,
    submittedPlan,
  };
}
