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
import { type Checkpointer, createCheckpointer } from "../checkpoint/checkpoint";
import { withCheckpoints } from "../checkpoint/wrapTools";
import type { CliDeps, RunContext } from "../cli";
import { printPreApproved, printWarning } from "../cli/output";
import { loadTrajectoryConfig, loadVerifyConfig, type VerifyConfig } from "../config/config";
import { getConfigDir, getTrajectoriesDir } from "../config/paths";
import { messageOf } from "../errors";
import type { PermissionMode } from "../gate/gate";
import { type ArchivistState, createArchivistState } from "../memory/archivist";
import { type LoadedMemory, loadMemory } from "../memory/store";
import { effectiveTools, loadGrants } from "../permissions/store";
import { fetchAccountPlan } from "../provider/accountStatus";
import { getModelCatalog } from "../provider/catalog";
import { DEFAULT_PROVIDER, resolveDefaultModel } from "../provider/defaults";
import { configuredProviders, PROVIDER_DISPLAY_NAMES } from "../provider/keys";
import { dispatchModel } from "../provider/model";
import { appliedReasoningEffort } from "../provider/reasoning";
import { type ResolvedRoute, resolveRoute } from "../provider/routing";
import { createToolDefinitions } from "../provider/tools";
import {
  findMostRecentSession,
  loadSession,
  type SessionState,
  saveSession,
} from "../session/session";
import { loadSkillRegistry, type SkillRegistry } from "../skills/registry";
import { type AgentRegistry, loadAgentRegistry } from "../subagents/registry";
import { createTrajectoryWriter, type TrajectoryWriter } from "../trajectory/writer";
import { destroyTuiRenderer } from "../tui/runtime/renderer";
import { type CommandDirs, checkpointTarget } from "../tui/state/commands";
import { withVerification } from "../verify/wrapTools";

// Shared by compactCommand and prepareSession (below): both resolve an already-known
// `{model, provider}` pair into a live route and a dispatched model the exact same way —
// configuredProviders, an independent catalog+plan fetch (run together rather than stacked,
// prepareSession's own comment on why explains the latency reasoning), resolveRoute, dispatchModel.
// runTui's own runTurn keeps its own inline version instead of calling this: it resolves against
// `prepared`'s already-fetched catalog/plan on every turn rather than fetching a fresh pair each
// time, a genuinely different shape this helper would only complicate by trying to also cover.
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
  // `resolveDefaultModel(configDir)`'s own provider, not a hardcoded `DEFAULT_PROVIDER` — mirrors
  // resolveSessionRoute's own defaulting (routing.ts's own comment on why): `provider` can
  // legitimately be undefined here (no session override, no explicit /model pick), and
  // resolveDefaultModel already resolves the correct pair for that case.
  const requestedProvider =
    requested.provider ?? resolveDefaultModel(configDir).provider ?? DEFAULT_PROVIDER;
  const [catalog, plan] = await Promise.all([
    getModelCatalog(undefined, warnSink),
    fetchAccountPlan(configDir),
  ]);
  const route = resolveRoute(
    catalog,
    { model: requested.model, provider: requestedProvider },
    configured,
    plan,
  );
  const model = dispatchModel(route, sessionId, configDir, deps);
  return { model, route, catalog, plan };
}

// `model`/`provider` are optional on SessionState so that sessions written before either field
// existed still load, but every session this function hands back has the `model` key — which is
// what lets the rest of the run stop asking, and getModel drop a default parameter for it.
// `provider` can still legitimately be `undefined` here: it means no provider was ever explicitly
// requested, not that one is missing.
export type RunSession = SessionState<ModelMessage> & {
  model: string;
  provider: ModelProvider | undefined;
};

// `modelRecorded` says where the model came from: true if the session file already had one, false
// if it was just resolved from the environment and no provider call has confirmed it exists.
// prepareSession uses it to decide whether the creation-time save may persist it — see there.
export function loadOrCreateSession(
  resuming: boolean,
  resumeId: string | undefined,
  sessionsDir: string,
  loadAgentsFileFn: typeof loadAgentsFileReal,
  configDir: string,
  cwd: string,
  // Injected, and called with the SAME cwd the AGENTS.md read below is given, which on a resume is
  // the session's own recorded cwd rather than the process's. Both feed one frozen context tier, so
  // resolving them from two different directories would let a resume launched from elsewhere pick
  // up this project's skills alongside that project's AGENTS.md. Discovered fresh on both paths for
  // the same reason the AGENTS.md read is: a skill added since the session was saved must be
  // visible on resume, and one deleted since must not be. Nothing skill-shaped is ever replayed out
  // of the session JSON.
  loadSkills: (cwd: string) => SkillRegistry,
  onTruncated: () => void = () => {},
): { session: RunSession; modelRecorded: boolean; skills: SkillRegistry } {
  if (resuming) {
    const id = resumeId ?? findMostRecentSession(sessionsDir);
    if (!id) throw new Error("No session to resume.");
    const loaded = loadSession<ModelMessage>(id, sessionsDir, onTruncated);
    // The two stored fields are treated differently on purpose.
    //
    // `systemPrompt` is rebuilt every time, never replayed: it is a product of this binary's
    // SYSTEM_PROMPT and the project's AGENTS.md, not something the conversation decided. A session
    // created before src/agents/systemPrompt.ts existed has the old 29-character identity line
    // frozen into its JSON, and honouring it would resume with no tool guidance at all — the exact
    // failure that module exists to fix, on precisely the sessions a user upgrading already has.
    // Rebuilding also means an AGENTS.md edited since is picked up. It reads from the session's own
    // cwd rather than the process's, so a resume launched from elsewhere still gets the project's
    // file, resolved from where the session itself was recorded rather than wherever this resume
    // happens to run from.
    //
    // Two costs of rebuilding, neither of which the old replay-the-stored-string path had, both
    // accepted rather than guarded: this puts a readFileSync on the resume path, so an AGENTS.md
    // that exists but cannot be read (EACCES) now fails a resume that used to run; and if the
    // session's cwd has since been DELETED, findAgentsFile walks up from a missing directory and
    // adopts the nearest ancestor's AGENTS.md, which may belong to an unrelated project. Falling
    // back to the stored prompt on either is not an option worth having — the stored prompt is
    // exactly the 29-character string this rebuild exists to stop serving.
    //
    // `model` is backfilled only when absent, so a session that recorded one keeps it and the
    // environment cannot switch models under a conversation already running on one. When `model`
    // is absent, `model`/`provider` are backfilled TOGETHER via resolveDefaultModel() — the same
    // pair a brand-new session starts on — never independently: resolveModelId() alone can return
    // a persisted non-groq SERI_MODEL (a successful /model pick on e.g. anthropic, per
    // persistDefaultModel), and pairing that with a separately-hardcoded "groq" would call the
    // wrong provider's API and fail confusingly. Note what this does NOT protect: a session
    // written before the field existed was really running llama-3.3-70b-versatile, nothing
    // records that, and this first resume moves it to whatever resolveDefaultModel() returns.
    //
    // `provider` alone can still be absent on a session that already recorded a `model` — a
    // session written before the `provider` field existed, or one where nothing was ever
    // explicitly picked. That's just passed through as-is: absence stays absence, since `provider`
    // can now legitimately be `undefined` all the way through (DEFAULT_PROVIDER is applied only
    // where a concrete provider is actually needed for routing, not backfilled here).
    const { model, provider } =
      loaded.model === undefined
        ? resolveDefaultModel(configDir)
        : { model: loaded.model, provider: loaded.provider };
    const skills = loadSkills(loaded.cwd);
    return {
      session: {
        ...loaded,
        systemPrompt: buildSystemPrompt({
          agentsContent: loadAgentsFileFn(loaded.cwd),
          skills: [...skills.values()],
        }),
        model,
        provider,
      },
      modelRecorded: loaded.model !== undefined,
      skills,
    };
  }

  // A brand-new session starts on whatever a previously successful `/model` pick persisted
  // (resolveDefaultModel's own comment), falling back to DEFAULT_MODEL/"groq" the same way
  // resolveModelId always has when nothing was ever picked.
  const { model, provider } = resolveDefaultModel(configDir);
  const skills = loadSkills(cwd);
  return {
    session: {
      id: randomUUID(),
      cwd,
      systemPrompt: buildSystemPrompt({
        agentsContent: loadAgentsFileFn(cwd),
        skills: [...skills.values()],
      }),
      // approve-each, not read-only: on native Windows the OS sandbox is not enforced
      // (docs/ARCHITECTURE.md:417), so the permission gate is the whole Base layer and a default
      // that does not ask is a default that writes unattended. read-only was tried and measured —
      // a fresh session given a write task was blocked repeatedly and produced nothing (step 0 of
      // the tui-ready-permissions loop: 5 denials, done: no-tool-call, no file created). This
      // reverses docs/ARCHITECTURE.md:93's rejection of "approval for every edit" as a default;
      // the allowlist ("always allow this tool", below) is what keeps this from being that
      // rejected every-call mode — permanent for write_file/edit since permanent-permissions-
      // allowlist, run-scoped for every other write tool the gate ever grows.
      permissionMode: "approve-each",
      model,
      provider,
      messages: [],
    },
    modelRecorded: false,
    skills,
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
): TrajectoryWriter {
  const cfg = loadTrajectoryConfig(configDir);
  return createTrajectoryWriter({
    dir: getTrajectoriesDir(configDir),
    sessionId: session.id,
    cwd: session.cwd,
    model: session.model,
    provider: session.provider,
    enabled: cfg.enabled,
    retentionDays: cfg.retentionDays,
    onWarning,
  });
}

// The three ways a run can begin, all derived from the same two RunContext fields (`resuming`,
// `taskText`) — one function rather than two independent booleans over the same inputs, which used
// to require its own comment on the second one just to defend it against the first ("deliberately
// NOT !hasNewTask(ctx)"). Shared by prepareSession (decides whether to push the initial user
// message), run()'s own usage-error gate, and runTui's own connectDispatch (decides whether to echo
// the task and whether to auto-start a turn) — one function, not the same distinction repeated at
// every call site, so they can't silently drift out of sync with each other.
//   "task"   — real task text was given (new session or --continue/--resume with new text): push,
//              echo, and start a turn on it.
//   "resume" — --continue/--resume with no new text: nothing to push or echo. Whether a turn
//              actually starts is a separate question the session's own messages answer, not
//              this classification alone — see session/awaitsReply.ts, and connectDispatch's use
//              of it, below.
//   "idle"   — no resume target and no task text (bare `seri` in a TTY): mount with nothing to do.
export type RunStart = "idle" | "task" | "resume";

export function runStart(ctx: RunContext): RunStart {
  if (ctx.taskText.length > 0) return "task";
  return ctx.resuming ? "resume" : "idle";
}

// A queued startup notice, tagged with the stream it was headed for — `fatalDuringTui` routes each
// one to `console.log`/`console.error` accordingly so a stdout-origin line (a routine "Session …
// created.") never gets reclassified as stderr-origin (a warning) just because both funnelled
// through the same queue. The TUI flush site (runTui's own `connectDispatch`) ignores `stream`
// deliberately: every queued line lands in the transcript either way, regardless of which stream
// it would have gone to on a non-TTY run.
export type PreMountMessage = { text: string; stream: "stdout" | "stderr" };

// Everything the loop is driven with, resolved before the first model call so a failure to build
// any of it is an exit code rather than a half-started turn.
//
// Code-review finding: `session` used to be typed as the loose `SessionState<ModelMessage>`
// (model/provider optional) even though `prepareSession` (below) only ever builds a fully-resolved
// `RunSession` — forcing a defensive `?? "groq"` fallback and two bare `as RunSession` casts
// downstream to re-assert, by convention, an invariant the type already failed to state. `RunSession`
// here means a future code path that legitimately produces a session without model/provider (an
// import/migration path, say) is a compile error at its own call site, not a silent fallthrough.
export type PreparedRun = {
  session: RunSession;
  storeDir: string;
  tools: ToolSet;
  model: LanguageModel;
  // Resolved here, the same way `model` is: a per-run fact the loop is driven with, carried
  // beside the session rather than assumed equal to `session.permissionMode`. `--dangerously-
  // skip-permissions` is the one thing that can make the two differ, and now that the value the
  // loop actually reads lives on this object instead of being re-derived at the call site, there
  // is no `session.permissionMode` assignment for a future edit to reach for by mistake — the
  // session this run started from is untouched, and driveLoop never sees anything else to assign.
  permissionMode: PermissionMode;
  // The project checkpoints already resolved this run against — carried here rather than
  // re-derived in driveLoop, which needs it too (rememberGrant) and would otherwise resolve the
  // project root a second time.
  worktree: string;
  // Resolved once here, exactly like `permissionMode` above and for the same reason: a per-run
  // fact the loop is driven with, carried on this object so driveLoop has nothing to re-derive and
  // nothing to assign into `session`.
  allowedTools: readonly string[];
  // Loaded once here (@seri/model-catalog caches it for the rest of the process anyway) and carried
  // on this object so runTui's own per-turn model re-resolution (runTurn, below — the /model fix)
  // has it without loading it again every turn.
  catalog: ModelCatalog;
  // The catalog's own entry for `model`/`provider`, above — undefined when the catalog has no
  // entry for this exact id/provider pair (an id typed straight into SERI_MODEL, say). driveLoop
  // reads two fields off it: `.contextWindow` (falls back to runLoop's own
  // DEFAULT_CONTEXT_WINDOW_SIZE when undefined, matching what every run did before this field
  // existed) and `.displayName` (falls back to the raw id, buildVolatileTier's own job). Carrying
  // the whole entry rather than just `contextWindow` means driveLoop needs exactly one
  // `findCatalogEntry` call per turn instead of two identical ones for the same (modelId, provider).
  catalogEntry: ModelCatalogEntry | undefined;
  // The (model, provider) pair the run actually resolved to, per resolveRoute —
  // NOT necessarily `session.model`/`.provider`,
  // which is what the session merely REQUESTED. runTui's own `confirmedModel`/`lastPersistedModel`
  // must initialize from this, not from `session`: starting them from the requested pair while
  // turn 1 actually runs on a rerouted one trips their inequality guards on turn 1 and persists a
  // switch the session never asked for — see those variables' own comments.
  route: ResolvedRoute;
  // Fetched once here, at session start, and reused for the life of the run (runTurn's own
  // per-turn resolveRoute call and the /model handler both read this instead of fetching again on
  // every turn/picker-open) — mutated in place, not re-fetched, so a plain read anywhere else in
  // the run always sees the current value. Null for a logged-out/BYOK-only session or on any fetch
  // failure (accountStatus.ts's own fail-closed contract). The two exceptions that DO refresh it
  // mid-run are the /login and /logout TUI handlers (runTui's own `onLogin`/`onLogout` call
  // sites) — without that, a successful /login left the startup `null` in place, and a successful
  // /logout left the previous (possibly paid) plan in place, so `resolveRoute`/`/model` could keep
  // reflecting stale auth state after either.
  plan: Plan | null;
  // The same Checkpointer `tools`' own withCheckpoints was built with — driveLoop's
  // withSubagents reuses it (as an OnBeforeMutation; Checkpointer is one, plus the two extras
  // below) for one pre-dispatch snapshot instead of building a second one. `Checkpointer`, not
  // `OnBeforeMutation`, so runTui's own /undo and /restore handling (its own comment near
  // `invalidate()`'s call site) can reach `.invalidate()` on the SAME live instance, not a second
  // one it would have no way to build.
  checkpointer: Checkpointer;
  // Resolved once here and passed into every buildCheckpointedTools call, including /clear's own
  // rebind (bindSession, below) — not re-read from disk there. `/config set` documents a verify
  // setting as taking effect "next run," not immediately (config/commands.ts's own comment); a
  // rebind that called loadVerifyConfig() fresh would silently contradict that for anyone who
  // toggled it mid-session and then ran /clear.
  verifyConfig: VerifyConfig;
  // Loaded once here, alongside everything else this object resolves once per run — "frozen per
  // session" (renderMemoryTier's own doc comment) means loaded HERE and nowhere else; a write made
  // mid-session takes effect next session, not this one. /clear is the one exception: it mints a
  // conceptually new session in the same process, so bindSession (below) reloads this alongside
  // the session-keyed checkpointer/tools/archivistState, rather than carrying the old session's
  // memory forward.
  memory: LoadedMemory;
  // The built-in agents plus whatever `.seri/agents/` and the profile root's `agents/` defined,
  // resolved once here and frozen for the session — the same rule `memory` above states, and for
  // the same reason: an agent file added mid-session takes effect next session. /clear is the one
  // exception (bindSession, below), which reloads it alongside memory.
  agents: AgentRegistry;
  // Whatever `.seri/skills/` and the profile root's `skills/` defined, resolved once and frozen for
  // the session — the same rule `memory` and `agents` above state, and for the same reason. Names
  // and descriptions only: a SkillSpec has no body (skills/skillFile.ts), so this map cannot be the
  // thing that puts a skill's instructions in front of the model. Only an actual invocation does
  // that, by reading the file. /clear is the one exception (bindSession, below), which reloads it
  // alongside memory and agents.
  skills: SkillRegistry;
  // Trajectory records for this session id. Rebound in bindSession the same way checkpointer/tools
  // are: /clear mints a new id, so a writer closed over the old one would keep appending under a
  // session nothing resumes. Disabled config still yields a no-op writer.
  trajectory: TrajectoryWriter;
  // Startup notices (session-created, permission warnings, pre-approved tools, the cross-project
  // checkpoint mismatch) that prepareSession would otherwise print directly. On the TUI path they
  // are queued here instead: prepareSession runs after runWelcomeSplash has already created the
  // shared renderer (getTuiRenderer, runtime/renderer.ts) but before runTui's own `root.render`
  // call, so a direct console write in that gap lands on the alt-screen buffer and is gone the
  // instant the TUI's first frame paints over it. runTui flushes this into the transcript at
  // mount. Empty on the non-TTY path, which still writes these directly (no alt screen there). Each
  // entry keeps the stream it was headed for — see PreMountMessage's own comment.
  preMountMessages: PreMountMessage[];
};

// Shared by prepareSession's own non-TTY notice and runTui's runTurn (below) — the two used to
// hand-duplicate this exact template literal,
// differing only by a leading "↻ " on the TUI path (that one repeats per turn, so the arrow marks
// it as a live event rather than the one-time startup notice prepareSession prints).
//
// `requestedProvider` is a separate parameter, not `route.reason` (still exactly
// PROVIDER_API_KEY_NAMES[requestedProvider] — resolveRoute's own return value, unchanged, and
// still what routing.test.ts asserts directly): this notice is purely informational, no embedded
// command, so it reads better with a display name (PROVIDER_DISPLAY_NAMES) than the raw env var
// constant — unlike missingKeyError's message, which needs the exact name because it IS one.
// `requestedProvider` here is literally the session's own `provider` field (itself
// `ModelProvider | undefined`) — there is no separate field to keep in sync with it, so it cannot
// drift out of sync with what was actually requested. `undefined` means a genuinely blank first
// run (or resume of one), which reroutes off resolveDefaultModel's own DEFAULT_PROVIDER fallback
// with no configured/requested provider at all — blaming a provider the user never named is worse
// than naming none. Captured on `session` at the point the pair was resolved (resolveDefaultModel/
// the model picker), not re-read here from config.json — see SessionState.provider's own comment
// for why.
export function rerouteNotice(
  route: ResolvedRoute,
  requestedProvider: ModelProvider | undefined,
): string {
  if (requestedProvider === undefined) {
    return `routing ${route.model} via ${route.provider} (your key)`;
  }
  return `routing ${route.model} via ${route.provider} (your key) — no ${PROVIDER_DISPLAY_NAMES[requestedProvider]} key configured`;
}

// The gateway counterpart to rerouteNotice above: a viaGateway route is served through the
// user's own seri plan, not a key they brought, so both the piped/non-interactive path and a live
// TUI turn need the same "never silent" notice a BYOK reroute already gets — otherwise a run
// consumes gateway quota with zero indication it ever left the user's own keys. Same
// `ModelProvider | undefined` signature and the same undefined branch as rerouteNotice, for the
// same reason: a genuinely blank first run named no provider at all, so blaming one (Groq, via
// DEFAULT_PROVIDER) in the "no X key configured" clause would name a provider the user never
// touched.
export function gatewayNotice(
  route: ResolvedRoute,
  requestedProvider: ModelProvider | undefined,
): string {
  if (requestedProvider === undefined) {
    return `routing ${route.model} via ${route.provider} on your seri plan`;
  }
  return `routing ${route.model} via ${route.provider} on your seri plan — no ${PROVIDER_DISPLAY_NAMES[requestedProvider]} key configured`;
}

// The one place a TTY-path failure becomes an exit code, used by every catch between
// `runWelcomeSplash`'s own renderer creation and `runTui`'s own mount (this function's own
// catches, and `run()`'s two try/catches around the steps on either side of `prepareSession`):
// destroys the renderer before printing anything (undiscarded messages need the primary screen
// restored first — the same reasoning `checkZeroKeysConfigured`'s own catch used to state on its
// own), then flushes any `preMountMessages` queued so far ahead of the fatal message itself,
// rather than dropping them — a queued "Session X created." or fallback-catalog warning would
// otherwise vanish with no trace once the run is already ending here instead of ever reaching
// runTui's own flush site (connectDispatch). Safe to call with `err` from ANY throw in this
// window, caught or uncaught, including one before `getTuiRenderer` was ever called
// (`destroyTuiRenderer`'s own no-op guard): this is also what closes the "stack trace printed
// into the discarded alt-screen buffer" failure mode for a genuinely uncaught exception, since
// `run()`'s own top-level catches route here too.
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

// Lifts the `createCheckpointer` + `withVerification(withCheckpoints(...))` pairing out of
// `prepareSession` so that `/clear`'s post-rebind construction (bindSession, below) and this
// function's own startup construction cannot drift into two differently-wrapped tool sets.
// `verifyConfig` is passed in, not re-read via `loadVerifyConfig()` here — PreparedRun's own
// comment on its `verifyConfig` field explains why a rebind must reuse the run-start value.
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

// Everything scoped to a session id, rebound in one place — the checkpointer/tools pair,
// PreparedRun.session, PreparedRun.memory, PreparedRun.trajectory, and the archivist's own
// counter/cursor, none of which stay valid once `session` is a conceptually different conversation
// (/clear's own case). Adding a session-scoped field to PreparedRun means updating this function,
// not hunting for the assignment site in runTui. Returns the new ArchivistState rather than
// assigning it directly: `archivistState` is a bare `let` in runTui, not a PreparedRun field, so
// the caller still does that one assignment itself.
export function bindSession(
  prepared: PreparedRun,
  session: RunSession,
  configDir: string,
  onWarning: (message: string) => void,
): ArchivistState {
  const trajectory = createSessionTrajectory(session, configDir, onWarning);
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
  // Reloaded from the SESSION's cwd, not the process's, matching decideClear's own rebuild of the
  // context tier this feeds — the two must agree or /clear would list one set of skills and load
  // another.
  prepared.skills = loadSkillRegistry({ worktree: session.cwd, configDir, onWarning });
  prepared.agents = loadAgentRegistry({
    worktree: prepared.worktree,
    configDir,
    catalog: prepared.catalog,
    onWarning,
  });
  prepared.session = session;
  prepared.trajectory = trajectory;
  return createArchivistState(session);
}

export async function prepareSession(
  ctx: RunContext,
  deps: CliDeps,
  skipPermissions: boolean,
  isTTY: boolean,
): Promise<PreparedRun | number> {
  const loadAgentsFileFn = deps.loadAgentsFile ?? loadAgentsFileReal;
  // See PreparedRun.preMountMessages' own comment: queued instead of printed on the TUI path,
  // printed immediately (unchanged) everywhere else. Two queueing sinks, not one: `emit` is for
  // stdout-origin lines (session-created, printPreApproved's own default), `warn` for stderr-origin
  // ones (printWarning's three call sites, getModelCatalog's fallback warning) — collapsing both
  // into one queue with no stream tag used to make `fatalDuringTui` print every one of them to
  // stderr regardless of origin, reclassifying a routine notice as an error.
  const preMountMessages: PreMountMessage[] = [];
  const emit = isTTY
    ? (text: string) => preMountMessages.push({ text, stream: "stdout" })
    : console.log;
  const warn = isTTY
    ? (text: string) => preMountMessages.push({ text, stream: "stderr" })
    : console.error;
  // Passed as printWarning's own `sink` param — `undefined` on the non-TTY path keeps its existing
  // default (console.error) exactly as before.
  const warnSink = isTTY ? warn : undefined;

  // One try wrapping everything from here through the final `return`: every fallible call in this
  // function — loadOrCreateSession, resolveRoute/getModel, saveSession, checkpointTarget,
  // loadGrants, createCheckpointer/loadVerifyConfig, loadMemory — shares this one catch, so nothing
  // in here can discard `preMountMessages` by falling outside it. `configDir` is resolved in here
  // too, not above the try: that function's own model/provider backfill, resolveDefaultModel,
  // needs the SAME configDir routing/getModel below already use, not the ambient default — a
  // sandboxed `authConfigDir` caller used to get session.model/session.provider read from the wrong
  // config.json entirely; `configDir` matches `seri config`'s own resolution, so a key `/setup` or
  // `seri config set` just wrote is picked up on the very next run. Being inside the try is what
  // makes `run()`'s own isTTY try/catch around this function's call site provably unreachable, see
  // that call site's own comment.
  try {
    const configDir = deps.authConfigDir ?? getConfigDir();
    const { session, modelRecorded, skills } = loadOrCreateSession(
      ctx.resuming,
      ctx.resumeId,
      ctx.sessionsDir,
      loadAgentsFileFn,
      configDir,
      ctx.cwd,
      (cwd) =>
        loadSkillRegistry({
          worktree: cwd,
          configDir,
          onWarning: (msg) => printWarning(msg, warnSink),
        }),
      () =>
        printWarning(
          "the last message in this session's saved history was incomplete (an interrupted save) and has been dropped — everything before it is intact",
          warnSink,
        ),
    );

    if (!ctx.resuming) emit(`Session ${session.id} created.`);

    if (runStart(ctx) === "task") {
      session.messages.push({ role: "user", content: ctx.taskText });
    }

    // resolveRoute sits ahead of getModel's dispatch, not inside it — getModel
    // stays a pure, environment-independent switch with its own test file.
    // Read here, before the routing decision that needs it: `getApiKey`'s own `loadConfig` call
    // does a bare `JSON.parse`, so a corrupted config.json throws SYNCHRONOUSLY — the same failure
    // mode `getModel` itself already guards against below, and why this needs to be inside the try
    // at all ("a corrupted config.json prints a clean error and exits 1," not an uncaught crash).
    // The catalog load and the plan fetch (inside resolveModelRoute) are independent network calls,
    // run together rather than stacked. `plan` is still fetched even when the session's own provider
    // already has a configured key (resolveRoute's own Rule 1 would discard it for THIS route): the
    // same `prepared.plan` also feeds /model's own gatewayCoverageInGroup predicate for every OTHER
    // model in the catalog the user might switch to later in the session (tuiPty.test.ts's "a
    // logged-in session's account-status fetch happens once at session start" — asserts the fetch
    // happens even though its own fixture sets GROQ_API_KEY, the DEFAULT_PROVIDER). `accountStatus.ts`'s
    // own login guard already skips the fetch for a BYOK-only/logged-out session. Resolved once,
    // here, alongside the model resolution it feeds — /model (runTui's own runTurn) reuses the SAME
    // catalog/plan on every later turn rather than reloading it (`prepared.catalog`/`.plan`, below),
    // but @seri/model-catalog caches for the rest of the process either way (catalog.ts's own
    // loadCatalog).
    const { model, route, catalog, plan } = await resolveModelRoute(
      { model: session.model, provider: session.provider },
      configDir,
      session.id,
      deps,
      warnSink,
    );
    // A rerouted OR gateway-served pair is never silent — the piped/non-interactive path gets
    // the notice here, gated on `!isTTY` — runTui's own runTurn (below) prints the TUI equivalent
    // into the transcript once per turn for either case, and this call ALSO runs on the TUI path
    // (this function has no other reason to know isTTY), so without the gate a session-start
    // reroute printed twice for the same turn: once here (before Ink even mounts) and again from
    // runTurn. `rerouted` and `viaGateway` are mutually exclusive (routing.ts's own ResolvedRoute
    // comment), so at most one of these ever fires. Both notices take `session.provider` directly
    // (not resolveModelRoute's own DEFAULT_PROVIDER-defaulted copy), matching rerouteNotice's own
    // undefined-aware contract: blaming DEFAULT_PROVIDER for a blank first run that never named one
    // is worse than naming none.
    if (route.rerouted && !isTTY) {
      printWarning(rerouteNotice(route, session.provider));
    } else if (route.viaGateway && !isTTY) {
      printWarning(gatewayNotice(route, session.provider));
    }
    // D3's own consequence: findCatalogEntry on the RESOLVED pair, not the requested one — otherwise
    // cost and context-window come from the wrong provider's entry.
    const catalogEntry = findCatalogEntry(catalog, route.model, route.provider);
    // The non-interactive counterpart to runTui's own per-turn notice (runTurn, below): a session
    // `reasoningEffort` override that the currently resolved route no longer considers legal is
    // dropped silently by loop.ts's own re-validation gate — surfaced here so this path is never
    // quieter than the TUI's, gated the same `!isTTY` way the reroute/gateway notices just above
    // are (runTurn prints the TUI equivalent into the transcript instead).
    if (
      session.reasoningEffort !== undefined &&
      appliedReasoningEffort(session.reasoningEffort, catalogEntry) === undefined &&
      !isTTY
    ) {
      printWarning(
        `reasoning effort "${session.reasoningEffort}" isn't legal for the current model — this turn runs without it.`,
      );
    }

    // A model this run merely RESOLVED is deliberately left out of the file. getGroqModel accepts
    // any string — an unknown id is not rejected here, it comes back as a provider 404 mid-run — so
    // pinning at creation mints a session that can never succeed, and `--continue`, the obvious
    // retry, re-reads the bad id and fails identically while a corrected SERI_MODEL is ignored.
    // driveLoop's messages-updated save records it instead, which loop.ts only emits after a turn
    // the provider actually answered (loop.ts:264 for text, :276 for tool calls; a failure yields
    // `error` and no messages-updated at all), so what gets pinned is a model that demonstrably
    // worked.
    //
    // opencode solves this upstream of the call, looking the id up in a provider catalog and
    // failing with `ModelNotFoundError` plus did-you-mean suggestions before anything is stored.
    // seri still pins only a model that answered: a typo in SERI_MODEL must not land in
    // config.json just because the catalog listed similar ids. A model the session already
    // recorded is untouched. It earned its place the same way.
    saveSession(modelRecorded ? session : { ...session, model: undefined }, ctx.sessionsDir);

    // Checkpointing is enabled by exactly this call, which is also why rolling it back is a
    // one-line revert: `runLoop`, the session store, the gate and every tool are unmodified, and
    // the store lives entirely outside the user's repository.
    const { storeDir, worktree } = checkpointTarget(session, dirs(ctx));

    // Read here and nowhere else. An unattended scheduled run must not copy this line. Every
    // entry in that file was written by a human answering a live prompt in a run they were watching.
    // That is consent for that run, not standing consent for one on a timer. Seeding a scheduled
    // run from here would disable the gate through a file instead of a flag. The daemon's
    // scheduled path uses permissionMode read-only and an empty allowlist instead.
    const grants = loadGrants(ctx.permissionsDir, worktree, (msg) => printWarning(msg, warnSink));
    const allowedTools = effectiveTools(grants);
    const permissionMode = skipPermissions ? "auto" : session.permissionMode;
    // approve-each only: in read-only the gate blocks these tools before it ever consults the
    // allowlist (gate.ts:14), and in auto everything is allowed anyway — printing "pre-approved" in
    // either would be a sentence the run does not honour. `isTTY ? emit : undefined`, not
    // `warnSink`: printPreApproved's own default sink is console.log, so queueing it under the
    // stderr-tagged `warn` would misclassify a routine notice as an error once fatalDuringTui
    // routes by stream.
    if (permissionMode === "approve-each" && allowedTools.length > 0) {
      printPreApproved(allowedTools, isTTY ? emit : undefined);
    }

    // Tools resolve relative paths against the session cwd, while the snapshot covers the project
    // root. Anywhere inside the project is fine — that is the whole point of resolving the root,
    // and it is why a subdirectory launch no longer trips this. What is left is a genuine
    // cross-project resume: it would snapshot one project while the tools edit another, and a later
    // /undo would run its removal pass in the ORIGINAL project, deleting untracked files a human
    // made there. Said out loud rather than left to be discovered by the deletion.
    const inProject = relative(worktree, session.cwd);
    if (inProject === ".." || inProject.startsWith(`..${sep}`) || isAbsolute(inProject)) {
      printWarning(
        `this session's files are checkpointed under ${worktree}, but tools run in ${session.cwd} — /undo will act on ${worktree}`,
        warnSink,
      );
    }

    // Verification is enabled by exactly this composition, and rolling it back is deleting the
    // outer call: `runLoop`, the gate, the session store and every tool are unmodified, and
    // `verify/` becomes dead code rather than something that has to be unpicked.
    //
    // Outside withCheckpoints, not inside: the checkpoint has to be taken BEFORE the write
    // (checkpoint/wrapTools.ts:18-22) and the check has to run AFTER it, so this is the order that
    // puts each on the correct side. The AbortSignal the check is run with is the one runLoop hands
    // `execute` (loop.ts:331), which is driveLoop's controller — the same Ctrl-C that stops a bash
    // command stops a check.
    // Resolved once, here — PreparedRun's own comment on `verifyConfig` explains why a later
    // /clear rebind (bindSession) must reuse this value rather than calling loadVerifyConfig again.
    const verifyConfig = loadVerifyConfig(configDir);
    const trajectory = createSessionTrajectory(session, configDir, (msg) =>
      printWarning(msg, warnSink),
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

    // Loaded once, here, alongside everything else this function resolves once per run — this is
    // what "frozen per session" means (memory/store.ts's own renderMemoryTier doc comment).
    const memory = loadMemory({ configDir, worktree });

    // Same freeze, and after `catalog` above rather than beside the other once-per-run reads: an
    // agent file's `model:` is resolved against the catalog's entries at load, so the catalog has
    // to be settled before any file is read. Every failure inside is a warning
    // routed through the same sink loadGrants uses — a malformed agent file never fails a start.
    const agents = loadAgentRegistry({
      worktree,
      configDir,
      catalog,
      onWarning: (msg) => printWarning(msg, warnSink),
    });

    // Reported here rather than refused at either loader, because neither loader can see the other:
    // skills load before the session so their listing can be frozen into the context tier, and
    // agents load after it because an agent file's `model:` needs the catalog. A shared name is not
    // fatal to either — the model still reaches both, through different tools — so only the ONE
    // surface they actually compete for is affected, `/name`, where cli.ts checks agents first. The
    // shadowed half is invisible without this line.
    for (const name of skills.keys()) {
      if (agents.has(name)) {
        printWarning(
          `"${name}" names both an agent and a skill; /${name} runs the agent. The skill is still reachable through the skill tool.`,
          warnSink,
        );
      }
    }

    return {
      session,
      storeDir,
      tools,
      model,
      permissionMode,
      worktree,
      allowedTools,
      catalog,
      catalogEntry,
      route,
      plan,
      checkpointer,
      verifyConfig,
      memory,
      agents,
      skills,
      trajectory,
      preMountMessages,
    };
  } catch (err) {
    return fatalDuringTui(err, preMountMessages);
  }
}
