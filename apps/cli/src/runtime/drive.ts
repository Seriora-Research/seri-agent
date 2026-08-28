import { findCatalogEntry, type ModelProvider } from "@seri/model-catalog";
import type { LanguageModel, ModelMessage } from "ai";
import { joinTiers, buildVolatileTier } from "../agents/systemPrompt";
import { appendBarrier } from "../checkpoint/checkpoint";
import type { CliDeps, PreparedRun, RunContext } from "../cli";
import { printGrantPersisted, printWarning, type RunUsage } from "../cli/output";
import { loadConfig } from "../config/config";
import { messageOf } from "../errors";
import type { PermissionMode } from "../gate/gate";
import { type ApprovalPrompt, type LoopEvent, runLoop as runLoopReal } from "../loop/loop";
import {
  type ArchivistReport,
  type ArchivistState,
  maybeRunArchivist,
  observeArchivistEvent,
} from "../memory/archivist";
import { rememberGrant } from "../permissions/store";
import type { CostReport } from "../provider/cost";
import { configuredProviders } from "../provider/keys";
import { dispatchModel } from "../provider/model";
import { resolveReasoningEffort } from "../provider/reasoning";
import type { SessionState } from "../session/session";
import { onSignalCancel } from "../signals";
import { type ChildEventPayload, withSubagents } from "../subagents/dispatch";
import {
  effortForChild,
  parseRolePins,
  pinFromTask,
  realizedRoute,
  resolveChildRoute,
  roleConstructionWarning,
  type RoutableRole,
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
  ranAnyTurn: boolean;
};

export type DriveLoopOptions = {
  signal?: AbortSignal;
  bindProcessCancel?: boolean;
  composeSubagents?: boolean;
  // Scheduled runs omit this child. maybeRunArchivist's only tool is memory_write, which is
  // not in the read-only scheduled toolset. Default remains true for attended CLI and TUI.
  runArchivist?: boolean;
};

export function exitCodeFromDriveResult(result: DriveLoopResult): 0 | 1 {
  if (!result.ranAnyTurn) return 0;
  if (result.doneReason === "no-tool-call") return result.refusedWithoutRunning ? 1 : 0;
  return 1;
}

export async function driveLoop(
  prepared: PreparedRun,
  ctx: RunContext,
  deps: CliDeps,
  maxTurns: number | undefined,
  onEvent: (event: LoopEvent) => void,
  getPermissionMode: () => PermissionMode,
  persist: (session: SessionState<ModelMessage>) => void,
  approvalPrompt: ApprovalPrompt,
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
    catalog,
    catalogEntry,
    route,
    checkpointer,
    memory,
  } = prepared;
  const runLoopFn = deps.runLoop ?? runLoopReal;
  const reasoningEffort =
    ctx.effortFlag ?? resolveReasoningEffort(session, loadConfig(ctx.configDir));

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
    buildVolatileTier(route.model, route.provider, catalogEntry?.displayName, memory),
  );
  const pins = parseRolePins(process.env, loadConfig(ctx.configDir));
  const configured = configuredProviders(ctx.configDir);
  type RoleOverlay = {
    model: LanguageModel;
    provider: ModelProvider;
    modelId: string;
    contextWindowSize: number | undefined;
    reasoningEffort: string | undefined;
    inherited: boolean;
  };
  const roleOverlays = new Map<string, RoleOverlay>();
  function overlayKey(role: RoutableRole, request: TaskRouteRequest | undefined): string {
    const pin = pinFromTask(request);
    const effort =
      typeof request?.effort === "string" && request.effort.length > 0 ? request.effort : "";
    if (pin === undefined && effort.length === 0) return role;
    return `${role}:${pin?.provider ?? ""}:${pin?.model ?? ""}:${effort}`;
  }
  function overlayFor(role: RoutableRole, request?: TaskRouteRequest): RoleOverlay {
    const key = overlayKey(role, request);
    const cached = roleOverlays.get(key);
    if (cached !== undefined) return cached;
    const intended = resolveChildRoute(
      role,
      route,
      pins,
      request,
      catalog,
      configured,
      prepared.plan,
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
            viaGateway: intended.viaGateway,
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
    };
    roleOverlays.set(key, overlay);
    return overlay;
  }
  const tools =
    driveOpts.composeSubagents === false
      ? baseTools
      : withSubagents(baseTools, {
          runLoop: runLoopFn,
          model,
          provider: route.provider,
          modelId: route.model,
          catalog,
          contextWindowSize: catalogEntry?.contextWindow,
          system,
          permissionMode: getPermissionMode,
          allowedTools,
          checkpointer,
          reasoningEffort,
          resolveRole: (role, request) => overlayFor(role, request),
          onChildUsage: (childUsage, childCost) => {
            usage.inputTokens = addTokens(usage.inputTokens, childUsage.inputTokens);
            usage.outputTokens = addTokens(usage.outputTokens, childUsage.outputTokens);
            cost = addCost(cost, childCost);
            prepared.trajectory.recordChildUsage(childUsage, childCost);
          },
          onChildEvent: (payload) => {
            prepared.trajectory.recordChildEvent(payload);
            onChildEvent?.(payload);
          },
        });
  let hadDenial = false;
  let ranTool = false;
  let archivist: ArchivistReport | undefined;
  try {
    for await (const event of runLoopFn({
      model,
      tools,
      messages: session.messages,
      // A getter, not a resolved-once value — see this function's own comment above for why.
      // loop.ts reads `opts.permissionMode` fresh on every gate check (loop.ts's own
      // decidePermission call), never caching it into a local at the top of the generator, which
      // is what makes a getter here actually take effect mid-turn rather than only on the next one.
      get permissionMode() {
        return getPermissionMode();
      },
      // A seed, not a
      // handle: the loop copies it (loop.ts:211) and growth comes back out as `tool-allowed`,
      // below.
      allowedTools,
      approvalPrompt,
      // Computed once above, so a live /model switch or reroute reaches subagents identically.
      system,
      signal: controller.signal,
      maxIterations: maxTurns,
      // Without these three, loop.ts's own cost branch (`opts.provider === "openrouter"`
      // / `opts.provider === "groq" && opts.modelId && opts.catalog`) never fires and every `usage`
      // event's `cost` field is silently undefined — the run genuinely never computes a cost, no
      // matter what cost.ts itself does. No `?? "groq"` fallback needed here (a prior version had
      // one): `route` (PreparedRun's own field) is never optional — `resolveRoute` always returns a
      // concrete pair. `route.model`/`.provider`, not `session.model`/`.provider`: this is the
      // pair the call is ACTUALLY being made against (this function's own comment just above), and
      // the two can differ from a routing-priority reroute. Using the requested pair here
      // would mis-tag a rerouted call's cost report with the wrong provider's pricing branch.
      provider: route.provider,
      modelId: route.model,
      catalog,
      // The catalog's own contextWindow for whatever model this turn is actually calling — a
      // /model switch to a provider/model with a different limit must change compaction's own
      // math, not just which endpoint gets called (PreparedRun.catalogEntry's own comment).
      contextWindowSize: catalogEntry?.contextWindow,
      reasoningEffort,
    })) {
      // The archivist's entire view of this turn — its own module owns what each event means to
      // it (memory/archivist.ts's own comment on observeArchivistEvent), so nothing else in this
      // loop mutates archivistState directly.
      observeArchivistEvent(archivistState, event);
      prepared.trajectory.recordLoopEvent(event);
      if (event.type === "messages-updated") {
        // `persist` (this function's own comment above explains the two callers) is the ONLY
        // write for this event now. driveLoop used to ALSO call saveSession directly here, using
        // the session THIS call started with, and rely on the TUI path's reducer to correct it
        // moments later. That left a real, if narrow, crash/fatal-signal window where the stale
        // write was the last one on disk. No direct saveSession call here anymore.
        persist({ ...session, messages: event.messages });
        onEvent(event);
        continue;
      }
      if (event.type === "permission-denied" && event.reason === "declined") hadDenial = true;
      if (event.type === "tool-call") ranTool = true;
      // Compaction splices the whole message array, so every rewind anchor recorded before this
      // point indexes into an array that no longer exists. The barrier is what lets `/rewind` say
      // so instead of silently slicing garbage. A session that never checkpointed has no log, and
      // appendBarrier no-ops rather than making this caller guess at that.
      //
      // Wrapped, because this is the only checkpoint call on the run path that was outside the
      // degrade-never-fail policy every other one obeys: the checkpointer catches and latches, and
      // the slash commands sit inside the dispatch's try. An appendFileSync that fails here —
      // ENOSPC, EACCES, the store removed mid-session — threw straight out of this loop and killed
      // the user's in-flight session, which is a checkpointing failure taking down the thing
      // checkpointing exists to protect. The cost of losing a barrier is that a later /rewind may
      // cross this compaction, so it is a warning and not silence.
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
      // `compacted` alongside `usage` because the summariser's own round-trip is billed like any
      // other call and was invisible to every caller until loop.ts stopped dropping it — a total
      // that left it out would under-report exactly the calls the user never asked for. Both
      // fields are `number | undefined` (the provider may report either, neither or both), which is
      // what addTokens carries through to the summary instead of flattening it to a zero.
      if (event.type === "usage" || event.type === "compacted") {
        usage.inputTokens = addTokens(usage.inputTokens, event.usage.inputTokens);
        usage.outputTokens = addTokens(usage.outputTokens, event.usage.outputTokens);
      }
      // `compacted` has no `cost` of its own (the summariser's own round-trip is billed the same
      // as any other call, but loop.ts does not price it — see loop.ts's own `usage` event comment
      // for the token half of the same asymmetry) — only `usage` carries one.
      if (event.type === "usage") cost = addCost(cost, event.cost);
      if (event.type === "done") doneReason = event.reason;
      onEvent(event);
      // After the dispatch above, not before: these are two lines of one message and the
      // run-scoped fact ("approved for the rest of this run") has to come first. Wrapped for the
      // same reason the appendBarrier call above is (see its comment): an EACCES, a full disk or a config dir
      // removed mid-session is a failure of the thing that remembers grants, and it must not take
      // down the user's in-flight run. Losing the grant costs one prompt next time, so it is a
      // warning, not silence — a grant the user believes was saved and was not is the Hermes #4739
      // failure.
      if (event.type === "tool-allowed") {
        try {
          if (rememberGrant(ctx.permissionsDir, worktree, event.name, printWarning))
            printGrantPersisted(event.name, worktree);
        } catch (err) {
          printWarning(
            `could not save the permanent approval for ${event.name}, so seri will ask again next time: ${messageOf(err)}`,
          );
        }
      }
    }

    // Inside the same try, before `finally` unregisters the cancel slot: the archivist's own child
    // runLoop must share `controller.signal` while that slot is still registered, per the
    // one-cancel-stops-everything contract every dispatch_subagents child already relies on.
    // maybeRunArchivist (memory/archivist.ts) owns the out-of-bounds cursor guard, the live
    // /memory archivist toggle read, and the trigger check — cli.ts carries none of that itself.
    // Scheduled driveLoop passes runArchivist: false so this child never runs on a timer.
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
      });
      prepared.trajectory.recordArchivist(archivist);
    }
  } finally {
    // In a finally, so a run that throws out of the loop does not leave the slot pointing at a
    // controller nothing is waiting on — a later signal would then be swallowed as a cancel of a
    // turn that is no longer running instead of killing the process.
    unregisterCancel();
  }

  return {
    doneReason,
    cancelledBy,
    usage,
    cost,
    refusedWithoutRunning: hadDenial && !ranTool,
    archivist,
    ranAnyTurn: true,
  };
}
