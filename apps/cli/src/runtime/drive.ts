import { randomUUID } from "node:crypto";
import { findCatalogEntry, type ModelProvider } from "@seri/model-catalog";
import type { LanguageModel, LanguageModelUsage, ModelMessage } from "ai";
import { buildVolatileTier, joinTiers } from "../agents/systemPrompt";
import { appendBarrier } from "../checkpoint/checkpoint";
import type { CliDeps, PreparedRun, RunContext } from "../cli";
import { printGrantPersisted, printWarning, type RunUsage } from "../cli/output";
import { loadConfig } from "../config/config";
import { messageOf } from "../errors";
import type { PermissionMode } from "../gate/gate";
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
import { configuredProviders } from "../provider/keys";
import { dispatchModel } from "../provider/model";
import { resolveReasoningEffort } from "../provider/reasoning";
import { DISPATCH_TOOL_NAME } from "../provider/tools";
import { createRuleInjector } from "../rules/match";
import type { SessionState } from "../session/session";
import { onSignalCancel } from "../signals";
import { withSkills } from "../skills/tool";
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

// undefined + n is n, not NaN, and undefined + undefined stays undefined: a run's total is the sum
// of the calls that reported, and stays unreported if none did.
export function addTokens(
  total: number | undefined,
  reported: number | undefined,
): number | undefined {
  return reported === undefined ? total : (total ?? 0) + reported;
}

// Same "sum what showed up" rule as addTokens, extended to a CostReport: the dollar amount sums
// like a token count (addTokens handles that half directly), but status/source are provenance
// tags, not numbers — VERIFY pass 2 caught that taking the most recent report's tags unconditionally
// lets a certain turn's "actual" mask an earlier turn's "estimated"/"unknown" in the running total,
// which is exactly the confident-looking-wrong-number failure the cost feature exists to prevent.
// A total is never more certain than its least-certain contributor: whichever of the two reports
// ranks weaker on COST_STATUS_RANK supplies BOTH the status and the source, not just the status.
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
  // Same shape as `usage`: summed across every `usage` event this call's runLoopFn yielded, via
  // addCost above. undefined when the run never got as far as a completed model call.
  cost: CostReport | undefined;
  // The one fact `run()`'s exit code actually needs, not the two inputs it would otherwise have
  // to reassemble itself: "refused at least once AND executed nothing at all" — see the tracking
  // below for what each half means and why.
  refusedWithoutRunning: boolean;
  // undefined on every turn that didn't trigger the archivist (the common case). Deliberately NOT
  // folded into `usage`/`cost` above — the verify bar demands the archivist's cost be
  // distinguishable from the main turn's, and summing it in would silently change what this file's
  // own printUsage/printCost assertions mean.
  archivist: ArchivistReport | undefined;
  // The transcript line for a `/name` turn: the agent it went to, then the child's own summary.
  // undefined on every ordinary turn. It exists because the synthetic tool-result clears the live
  // roster the moment the child finishes, and no parent turn follows to say what came back — the
  // user would otherwise watch a roster row appear and vanish with nothing to show for it.
  directSummary: string | undefined;
  // Always true from driveLoop's own return, below — reaching it means a turn ran, unconditionally.
  // runTui's own resolveRunTui (quit(), further down) is the one caller that can genuinely produce
  // `false` here: an idle TUI session the user quit without ever submitting a task never calls
  // driveLoop at all, so its own closure copy of this flag stays at its initial `false`. Not
  // optional — driveLoop setting it unconditionally is what makes `false` mean exactly one thing
  // (nothing ever ran) instead of also being read as "the non-interactive caller didn't bother."
  ranAnyTurn: boolean;
};

export type DriveLoopOptions = {
  // When set, aborting this signal aborts the same controller the loop is driven with. Direct
  // CLI/TUI callers omit it; the daemon passes the per-turn controller so cancel is keyed by
  // turnId rather than by process signal.
  signal?: AbortSignal;
  // Default true: register the process SIGINT/SIGTERM cancel slot (first-cancels, second is
  // fatal). The daemon sets this false so a Ctrl-C at `seri serve` is not stolen by an in-flight
  // turn's slot.
  bindProcessCancel?: boolean;
  // Default true: wrap tools with dispatch_subagents. Scheduled runs never compose that tool.
  composeSubagents?: boolean;
  // Scheduled runs omit this child. maybeRunArchivist's only tool is memory_write, which is
  // not in the read-only scheduled toolset. Default remains true for attended CLI and TUI.
  runArchivist?: boolean;
  // `/name <task>` from the TUI: run this one agent on this goal instead of calling the parent
  // model. Everything above the engine — route resolution, overlays, the checkpointer, the system
  // tier, the usage fold — is shared with an ordinary turn; only the engine differs.
  directDispatch?: { agent: AgentSpec; goal: string };
};

export function exitCodeFromDriveResult(result: DriveLoopResult): 0 | 1 {
  if (!result.ranAnyTurn) return 0;
  if (result.doneReason === "no-tool-call") return result.refusedWithoutRunning ? 1 : 0;
  return 1;
}

// `maxTurns` is an argument rather than a field of ctx: it is neither the resume target nor where
// its state lives, and this is the only place that reads it. `onEvent` is how it reports events —
// driveLoop only ever calls it with the raw LoopEvent, never anything TUI-shaped: printEvent
// directly for the non-interactive path, `(event) => dispatch({type: "loop-event", event})` for
// the TUI one (runTui, further down), which is the one place that still needs a TuiAction at all.
// A plain callback rather than driveLoop taking a Dispatch and wrapping every event in a
// `loop-event` envelope itself (which is all this function ever did with one) — that used to make
// the non-interactive path build a TUI action just so printDispatch could unwrap it again, and
// pull TuiAction into a loop-driving path that has no other reason to know a TUI type exists. The
// loop-driving logic itself (the `for await`, the cancellation/AbortController handling) is
// unchanged either way.
//
// `getPermissionMode` is read fresh on every gate check (via the getter below), not resolved once
// like `model`/`allowedTools`/`worktree` are — a real bug this fixes (reported live on a pty): the
// non-interactive path's `getPermissionMode` is just `() => prepared.permissionMode`, frozen for
// the run's whole duration exactly as before; the TUI path's reads whatever the reducer's CURRENT
// session says, so a mid-run /mode takes effect on the very next tool call rather than only on the
// next turn.
//
// `persist` is what actually writes a messages-updated session to disk — a callback rather than a
// hardcoded `saveSession` call, because the TWO callers need different answers to "does driveLoop
// own persistence for this session." The non-interactive path passes `(s) => saveSession(s,
// ctx.sessionsDir)`, unchanged. The TUI path passes a no-op: even a correct merge dispatched to the
// reducer still left a ~6ms window where this function's own direct write (using the session the
// CURRENT turn started with) was the last word on disk, since the reducer's own onSessionChange
// effect corrects it asynchronously, not synchronously. A crash, a fatal Ctrl-C or a SIGTERM
// landing in that window still persisted a reverted /mode. A no-op here closes the window
// entirely rather than narrowing it: the reducer (via App.tsx's onSessionChange) is the ONLY
// writer on the TUI path, full stop.
//
// `approvalPrompt` is the other per-caller swap: this used to be hardcoded to
// `makeApprovalPrompt(deps.createInterface)` inside this
// function, called on EVERY path including the TUI one — but makeApprovalPrompt opens its own
// readline.Interface on process.stdin and has its own `rl.on("SIGINT", ...)`, which on the TUI
// path fights Ink for stdin ownership (Ink's own useInput already owns raw mode there) and races
// signals.ts's single cancel slot with a second, independent SIGINT route. The non-interactive
// path still passes `makeApprovalPrompt(deps.createInterface)`, unchanged; the TUI path
// (runTui, further down) passes its own tuiApprovalPrompt — the SAME ApprovalPrompt contract
// (loop.ts), resolved via the reducer's own pendingApproval state and a keypress instead of
// readline.question, which is what the research spec's own "Command migration" section already
// said a TUI would supply: "a different function of the identical signature... with zero change
// to loop.ts/gate.ts."
export async function driveLoop(
  prepared: PreparedRun,
  ctx: RunContext,
  deps: CliDeps,
  maxTurns: number | undefined,
  onEvent: (event: LoopEvent) => void,
  getPermissionMode: () => PermissionMode,
  persist: (session: SessionState<ModelMessage>) => void,
  approvalPrompt: ApprovalPrompt,
  // The tool-call counter/message cursor the archivist trigger reads and advances — one instance
  // per SESSION, created by this function's two callers (createArchivistState), not rebuilt here,
  // so the counter accumulates across every turn of that session rather than resetting on each
  // driveLoop call. runTui's own copy is a `let`, not a `const`: /clear replaces it with a fresh
  // `createArchivistState` the moment it mints a new session id — that caller's own comment on why
  // this is a rebuild, not a reset, applies here too.
  archivistState: ArchivistState,
  // TUI live panel; the non-interactive caller omits it. Not folded into onEvent, which stays
  // LoopEvent only.
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
  const reasoningEffort = resolveReasoningEffort(session, loadConfig(ctx.configDir));

  // The controller lives here, not in the loop: runLoop is a library that is handed a signal, and
  // the consumer is the only thing that knows what a Ctrl-C means. Direct CLI/TUI callers register
  // the process cancel slot (first press lands in signals.ts, aborts the turn, the loop unwinds
  // far enough to yield a final messages-updated — which the body below persists, so the session
  // left behind is resumable; the second press finds the slot empty and takes the file's untouched
  // fatal path). An injected `signal` aborts that same controller so a daemon turn can be cancelled
  // without touching the process slot.
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
  // Hoisted so this and runLoopFn's own `system` opt below are the exact same value. Recomputed
  // every driveLoop call (once per TUI turn, once per non-interactive process), from the RESOLVED
  // model/provider (`route`) — never captured once at session start, so a
  // live /model switch OR a routing-priority reroute is reflected on the very next turn instead of
  // confabulated. `route`, not `session.model`/`.provider`: `session` carries what was REQUESTED,
  // and a rerouted turn's system prompt/cost provenance must name the model actually being called,
  // not the one that was asked for and silently rerouted away from.
  const system = joinTiers(
    session.systemPrompt,
    buildVolatileTier(route.model, route.provider, catalogEntry?.displayName, memory),
  );
  // Pins are re-read every turn so a mid-session env or config change takes effect next turn, the
  // same freshness reasoningEffort already has. A task's own model+provider pair, when complete,
  // wins over those defaults. Construction failures warn and reuse the session model rather than
  // failing the parent turn. Computed even when composeSubagents is false: maybeRunArchivist
  // still needs the archivist overlay.
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
  function overlayKey(role: string, request: TaskRouteRequest | undefined): string {
    const pin = pinFromTask(request);
    const effort =
      typeof request?.effort === "string" && request.effort.length > 0 ? request.effort : "";
    if (pin === undefined && effort.length === 0) return role;
    return `${role}:${pin?.provider ?? ""}:${pin?.model ?? ""}:${effort}`;
  }
  // `role` is any agent name — a built-in, the archivist, or one a user's own agent file defines.
  // Only a name in ROUTABLE_ROLES has a SERI_ROLE_* env pin to look up, and agent files are barred
  // from those names, so a file-defined agent falls straight through to its own request.
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
  // Hoisted rather than built inline in the composition below, because directDispatch (further
  // down) runs its one child against this exact same runtime: same overlay resolution, same
  // checkpointer, same usage fold, same child-event forwarding. A `/name` child and a
  // model-issued one differ in who chose the agent, in nothing else.
  const subagentRuntime = {
    runLoop: runLoopFn,
    model,
    provider: route.provider,
    modelId: route.model,
    catalog,
    contextWindowSize: catalogEntry?.contextWindow,
    system,
    agents: prepared.agents,
    permissionMode: getPermissionMode,
    allowedTools,
    checkpointer,
    reasoningEffort,
    cwd: worktree,
    resolveRole: (role: string, request?: TaskRouteRequest) => overlayFor(role, request),
    // Folds every child's usage/cost into the SAME accumulators the runLoopFn loop below uses, so
    // subagent tokens land in the run's own reported total instead of vanishing.
    // Child token spend is not a parent LoopEvent, so the writer records it here.
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
  // The one composition that enables dispatch_subagents; deleting this call (tools -> baseTools)
  // is the whole rollback, matching withCheckpoints/withVerification's own comment in prepareSession.
  // Scheduled runs pass composeSubagents: false so that tool never exists on the unattended path.
  const dispatchable =
    driveOpts.composeSubagents === false ? baseTools : withSubagents(baseTools, subagentRuntime);
  // Needs no flag of its own: withSkills adds nothing when the registry holds no model-visible
  // skill, and the one path that must never see this tool — a scheduled run — is built with an
  // empty registry, so its absence there is structural rather than conditional. withMcp composes
  // the same way, on the same terms: it adds nothing for a registry with no cataloged tool, which
  // is what a fresh install or an unpreviewed server both look like.
  const tools = withMcp(
    withSkills(dispatchable, prepared.skills),
    prepared.mcp,
    prepared.mcpClients,
  );
  // Tracked here, not in loop.ts: whether "no-tool-call" counts as success is a judgement about
  // what an exit code promises a shell, which is this consumer's business, not the loop's.
  // `permission-denied` fires on two different facts carried in its `reason` — "blocked" is a
  // mode (read-only, say) doing exactly what the user asked, not a signal anything went wrong;
  // "declined" is a live refusal, either an actual "no" or nobody there to ask at all. Counting
  // "blocked" here would flip `seri --resume x "review this repo" && open report.md` to exit 1
  // solely because a read-only session correctly refused a write probe mid-review, breaking the
  // `&&` over a mode working as intended. Only "declined" sets `hadDenial`. `tool-call` fires only
  // for a call that both passed the gate and had a real tool definition (the unknown-tool branch
  // also `continue`s past it) — so `ranTool` is exactly "did anything actually run".
  let hadDenial = false;
  let ranTool = false;
  let archivist: ArchivistReport | undefined;
  let directSummary: string | undefined;

  // `/name <task>`: one agent the USER picked, run in place of a parent model call. It yields the
  // same LoopEvent stream the loop would for a dispatch the model itself issued — tool-call,
  // tool-result, messages-updated, done — which is why persistence, the trajectory writer, the
  // live subagent panel, turn-started/turn-ended and Ctrl-C all keep working with no change at
  // those sites. The `tool-result` clears the live roster (reducer.ts's EMPTY_ROSTER), which is
  // what `directSummary` below is for — see its own doc on DriveLoopResult. The events also reach
  // observeArchivistEvent, so a `/name` turn counts toward the archivist trigger like any other
  // tool-using turn — intended: a dispatch is a dispatch whoever asked for it.
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
    // Read literally — "the turn ended with no pending model tool call" — this is true, and it
    // keeps the four consumers that exhaustively switch on `done.reason` unchanged.
    yield { type: "done", reason: controller.signal.aborted ? "aborted" : "no-tool-call" };
  }

  try {
    for await (const event of driveOpts.directDispatch !== undefined
      ? directDispatchEvents(driveOpts.directDispatch)
      : runLoopFn({
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
          // The `mcp` tool composed above is one ToolSet key standing in for every tool on every
          // configured server — mcpCallSubject is what tells the gate, the approval prompt and
          // every rendered event which one a given call actually means, resolving to the umbrella
          // `mcp` name only for a shape it does not recognise as one of its own (its own comment in
          // mcp/tool.ts). Every non-mcp call is unaffected: mcpCallSubject returns the ToolSet key
          // unchanged for anything that isn't literally "mcp".
          callSubject: mcpCallSubject,
          approvalPrompt,
          // Computed once above, so a live /model switch or reroute reaches subagents identically.
          system,
          // undefined when this session defines no glob-scoped rule, which is the common case and
          // costs the loop nothing. The parent loop only: a subagent builds its own message array
          // (subagents/dispatch.ts), and a child still inherits every `alwaysApply` rule through
          // the shared system tiers.
          onToolPhaseEnd: createRuleInjector({
            rules: prepared.rules,
            state: prepared.rulesState,
            worktree: prepared.worktree,
            cwd: session.cwd,
          }),
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
          // undefined for anything that is not a cataloged MCP tool — exactly today's behaviour
          // for write_file/edit, since rememberGrant refuses a fingerprint on a built-in name and
          // requires one on an mcp_ name (permissions/store.ts). No branch needed at this call
          // site: the one function already knows which of its two shapes each name takes.
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
    directSummary,
    ranAnyTurn: true,
  };
}
