import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import { flushSync } from "@opentui/react";
import { DaemonClient, isLoopDaemonEvent } from "@seri/daemon-client";
import {
  findCatalogEntry,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
} from "@seri/model-catalog";
import type { Plan } from "@seri/plans";
import type { LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { createElement } from "react";
import pkg from "../package.json";
import { onAbort } from "./abort";
import type { loadAgentsFile as loadAgentsFileReal } from "./agents/loadAgentsFile";
import { buildSystemPrompt, buildVolatileTier, joinTiers } from "./agents/systemPrompt";
import { ensureOwnerOnlyDir } from "./atomicWriteFile";
import { login as loginReal, logout as logoutReal } from "./auth/commands";
import { getWorkosClientId } from "./auth/deviceFlow";
import {
  appendBarrier,
  type Checkpointer,
  createCheckpointer,
  type RestorePlan,
  type RestoreResult,
} from "./checkpoint/checkpoint";
import { withCheckpoints } from "./checkpoint/wrapTools";
import {
  assertTuiHandlers,
  type CommandMeta,
  commandByName,
  isTuiClaimed,
  sessionMeta,
} from "./cli/commandCatalog";
import {
  approvalPromptText,
  archivistLine,
  archivistStatsLine,
  printCost,
  printEvent,
  printGrantPersisted,
  printPreApproved,
  printUsage,
  printWarning,
  type RunUsage,
  recoveryLines,
  USAGE,
  undoPlanLines,
  usageError,
} from "./cli/output";
import {
  loadConfig,
  loadReasoningEffortConfig,
  loadTrajectoryConfig,
  loadVerifyConfig,
  persistDefaultReasoningEffort,
  setConfigValue,
  type VerifyConfig,
} from "./config/config";
import {
  getConfigDir,
  getTrajectoriesDir,
  profileNameError,
  resolveProfile,
  setProfileOverride,
} from "./config/paths";
import { readDaemonDescriptorFile } from "./daemon/descriptor";
import type { RunScheduled } from "./daemon/scheduler";
import {
  type ExecuteTurn,
  type StartedDaemon,
  startDaemon as startDaemonReal,
} from "./daemon/server";
import { messageOf } from "./errors";
import type { PermissionMode } from "./gate/gate";
import { compactMessages, findSafeEvictionBoundary } from "./loop/compaction";
import {
  type ApprovalAnswer,
  type ApprovalPrompt,
  DEFAULT_PRESERVE_RECENT_MESSAGES,
  type LoopEvent,
  runLoop as runLoopReal,
} from "./loop/loop";
import {
  type ArchivistReport,
  type ArchivistState,
  createArchivistState,
  resetArchivistForRewind,
} from "./memory/archivist";
import { decideMemoryCommand } from "./memory/commands";
import { type LoadedMemory, loadMemory } from "./memory/store";
import { effectiveTools, loadGrants, PERSISTABLE_TOOLS, rememberGrant } from "./permissions/store";
import { fetchAccountPlan } from "./provider/accountStatus";
import type { getAnthropicModel as getAnthropicModelReal } from "./provider/anthropic";
import { getModelCatalog } from "./provider/catalog";
import type { CostReport } from "./provider/cost";
import { DEFAULT_PROVIDER, persistDefaultModel, resolveDefaultModel } from "./provider/defaults";
import type { getGatewayModel as getGatewayModelReal } from "./provider/gateway";
import type { getGoogleModel as getGoogleModelReal } from "./provider/google";
import type { getGroqModel as getGroqModelReal } from "./provider/groq";
import { configuredProviders, PROVIDER_DISPLAY_NAMES, tuiMissingKeyMessage } from "./provider/keys";
import { dispatchModel } from "./provider/model";
import type { getOpenAIModel as getOpenAIModelReal } from "./provider/openai";
import type { getOpenRouterModel as getOpenRouterModelReal } from "./provider/openrouter";
import {
  appliedReasoningEffort,
  type EffortCommandResult,
  resolveEffortCommand,
  resolveReasoningEffort,
} from "./provider/reasoning";
import {
  gatewayCoverageInGroup,
  type ResolvedRoute,
  resolveLegalReasoningTiers,
  resolveRoute,
  resolveSessionRoute,
} from "./provider/routing";
import { toolDefinitions } from "./provider/tools";
import {
  addCost,
  addTokens,
  type DriveLoopResult,
  driveLoop,
  exitCodeFromDriveResult,
} from "./runtime/drive";
import { awaitsReply } from "./session/awaitsReply";
import { type SessionState, saveSession } from "./session/session";
import { deliverSignal, onSignalCancel, raiseSignal } from "./signals";
import { grep as grepReal } from "./tools/grep";
import { resolveRg, rgVersion } from "./tools/runRipgrep";
import { createTrajectoryWriter, type TrajectoryWriter } from "./trajectory/writer";
import { App } from "./tui/app";
import { runGuidedSetup } from "./tui/routes/setup/guidedSetup";
import { runWelcomeSplash } from "./tui/routes/setup/welcomeSplash";
import { destroyTuiRenderer, getTuiRenderer } from "./tui/runtime/renderer";
import { runUsageCommand as runUsageCommandReal } from "./usage/command";

export { addCost, addTokens };

import {
  bindSession,
  dirs,
  fatalDuringTui,
  gatewayNotice,
  type PreMountMessage,
  type PreparedRun,
  prepareSession,
  type RunSession,
  rerouteNotice,
  resolveModelRoute,
  runStart,
} from "./runtime/prepare";

export type { PreMountMessage, PreparedRun, RunSession };

import {
  type CommandDirs,
  checkpointTarget,
  decideAuthOffer,
  decideClear,
  decideConfigOpen,
  decideEffortOpen,
  decideMaxTurns,
  decideModeCycle,
  decideModelPickerOpen,
  decidePermissionsOpen,
  decideProfileCreate,
  decideRestore,
  decideRewind,
  decideSetupOpen,
  decideTrajectoryCommand,
  decideUndo,
} from "./tui/state/commands";
import {
  createAuthHandlers,
  createConfigHandlers,
  createEffortHandlers,
  createPermissionsHandlers,
  createSetupHandlers,
} from "./tui/state/handlers";
import { type Dispatch, initialTuiState, type TuiState, tuiReducer } from "./tui/state/reducer";
import { estimateTokens } from "./tui/util/format";
import { withVerification } from "./verify/wrapTools";

export type CliDeps = {
  runLoop?: typeof runLoopReal;
  getGroqModel?: typeof getGroqModelReal;
  // All five mirror getGroqModel exactly — getModel (provider/model.ts) dispatches to whichever
  // of the five a session's provider names, so a test injecting some but not others still gets
  // the real implementation for whichever provider it never exercises.
  getOpenRouterModel?: typeof getOpenRouterModelReal;
  getAnthropicModel?: typeof getAnthropicModelReal;
  getOpenAIModel?: typeof getOpenAIModelReal;
  getGoogleModel?: typeof getGoogleModelReal;
  // Not one of the five above: a gateway route's provider is always GATEWAY_PROVIDER
  // (planCoverage.ts) but its credential is the WorkOS session, not a local provider key — getModel
  // has no notion of the gateway at all (deliberately: it stays a pure, environment-independent
  // provider switch). dispatchModel below is what branches on route.viaGateway before either
  // getModel or this is ever called.
  getGatewayModel?: typeof getGatewayModelReal;
  loadAgentsFile?: typeof loadAgentsFileReal;
  sessionsDir?: string;
  checkpointsDir?: string;
  authConfigDir?: string;
  login?: typeof loginReal;
  logout?: typeof logoutReal;
  usageCommand?: typeof runUsageCommandReal;
  startDaemon?: typeof startDaemonReal;
  executeTurn?: ExecuteTurn;
  runScheduled?: RunScheduled;
  onIdleFlush?: (sessionId: string, signal: AbortSignal) => Promise<void>;
  waitForServe?: () => Promise<void>;
  fetch?: typeof fetch;
  // The directory holding permissions.yaml. Deliberately NOT reusing `authConfigDir`: that name is
  // already stretched across auth AND `seri config`, and a third consumer that is neither would
  // make it mean nothing. Same shape as sessionsDir/checkpointsDir, defaulting to getConfigDir().
  permissionsDir?: string;
  grep?: typeof grepReal;
  createInterface?: () => Interface;
  // Whether to mount the Ink TUI instead of the piped/non-interactive path — read from a real
  // process.stdout.isTTY in exactly one place, the import.meta.main entrypoint at the bottom of
  // this file, and threaded in from there. Defaults to false (below), never to a live
  // process.stdout.isTTY read inside run() itself: cli.test.ts calls run() directly, bypassing
  // import.meta.main entirely, and a bare process.stdout.isTTY read would fire identically for a
  // real invocation and a test call — mounting a raw-mode-input Ink app inside a test process
  // whenever the test runner happens to have a real terminal attached (a human running `bun test`
  // in an actual terminal window, not CI). The safe default is what makes every existing test
  // call site (which never passes isTTY) correctly never mount the TUI, regardless of what
  // terminal the test process happens to run in.
  isTTY?: boolean;
};

// The presentation half of the decision/presentation split (research-spec) for /mode, /undo,
// /restore and /rewind: the DECISION is one of the pure functions in tui/commands.ts (Phase 2) —
// this is only how the result is shown, with two implementations mirroring ApprovalPrompt's own
// two-implementation shape. consolePresenter (below) is what every command used, inline, before
// this refactor — console.log, byte-for-byte unchanged; tuiPresenter (near the TUI entry point
// further down) dispatches into the live transcript instead. `restore` mirrors what /undo and
// /restore return (`{plan, message}` — RestoreResult is a RestorePlan plus the recovery commit);
// `sessionUpdated` is only ever called by /mode and /rewind, the two commands that actually change
// the session — /undo and /restore never touch it, so they never call it. `onPlan` is /undo and
// /restore's own pre-mutation report (output.ts's own documented guarantee on undoPlanLines:
// "before the restore happens, not after") — threaded through to decideUndo/decideRestore
// (tui/commands.ts) rather than folded into `restore`, which only ever sees the FINAL result.
//
// `sessionUpdated` OWNS persistence, not optional: it is the only thing that ever calls
// saveSession on the non-interactive path (consolePresenter's own implementation) or, on the TUI
// path, the only thing that dispatches session-updated at all — the reducer's own onSessionChange
// effect is what actually persists there. Before this, cycleModeCommand/rewindCommand called
// saveSession directly AND called sessionUpdated, the exact "caller keeps its own copy" shape
// MEDIUM-1 was opened to eliminate for driveLoop, left standing here — not a live race (nothing
// else wrote in between on either path), but the same shape as a bug five rounds went into
// closing does not get to stand next to a comment (driveLoop's own, and this file's) claiming the
// reducer is the ONLY writer on the TUI path.
//
// Returns `Promise<void>`, genuinely awaitable — not just typed that way for form. On the
// non-interactive path (consolePresenter) the underlying saveSession call is already
// synchronous, so the promise settles immediately either way. On the TUI path (tuiPresenter) it
// does NOT settle until the reducer's own onSessionChange effect actually runs and persists that
// session — the fix for a real gap found by code review: rewindCommand used to call
// `recordBarrier()` right after `sessionUpdated(next)` on the strength of a comment claiming the
// truncation was "already persisted by this point," true on the non-interactive path but not on
// the TUI path, where sessionUpdated only ever dispatched (persistence was, and still is, effect-
// driven — see onSessionChange's own comment). A crash/kill in that window could leave a barrier
// durably recorded pointing at a truncation that never reached disk, exactly what finding 9 was
// supposed to prevent. Making this awaitable — not adding a second writer, the effect is still
// the only one — is what lets a caller that needs the ordering (rewindCommand) actually get it.
type CommandPresenter = {
  message: (text: string) => void;
  onPlan: (plan: RestorePlan) => void;
  restore: (result: { plan: RestoreResult; message: string }) => void;
  sessionUpdated: (next: SessionState<ModelMessage>) => Promise<void>;
  // /clear's own hook: wipes whatever is rendering the transcript. Only meaningful where something
  // is actually rendered — the non-interactive path has no live transcript to wipe (consolePresenter's
  // own no-op below).
  transcriptCleared: () => void;
  // Reports a compaction summarizer round-trip's real token spend, which does not flow through
  // driveLoop's own usage fold (compactCommand never runs inside driveLoop) and would otherwise be
  // silently dropped from the run's reported totals — the same failure class loop.ts's own
  // "compacted alongside usage" comment already documents for the automatic path. No `cost`
  // parameter: compactMessages returns only `usage`, matching the automatic path's own asymmetry
  // (loop.ts's comment on `"compacted" has no cost of its own`).
  usageAccrued: (usage: LanguageModelUsage) => void;
  // /compact's own cancellation report — the SIGINT-exit-code contract (run()'s own comment on why
  // it re-raises rather than exiting plainly) applies to a cancelled /compact too, but only on the
  // non-interactive path: consolePresenter re-raises the signal after reporting, matching
  // driveLoop's own re-raise; tuiPresenter only appends a transcript line, matching the LOW-J
  // precedent (a per-turn cancel returns control to the input prompt, not to process death).
  cancelled: (signal: NodeJS.Signals) => void;
  // /compact's own hook, read at persist time rather than trusted from its caller's pre-await
  // snapshot: compactCommand holds two real awaits (the catalog/plan fetch, the summarizer's own
  // round trip) between reading `session` and building its result, and /mode is deliberately NOT
  // gated by `turnInFlight` while /compact runs (SlashCommand's own comment on why /mode is exempt)
  // — so a /mode change landed mid-compact would otherwise be overwritten when /compact spreads
  // its own stale `session` back out. consolePresenter has nothing else running concurrently to
  // race, so it just echoes back whatever it was constructed with; tuiPresenter reads runTui's own
  // `liveState.session` (this file's own comment on why that, not a closure, is the live source of
  // truth on the TUI path).
  currentSession: () => SessionState<ModelMessage>;
};

type SlashCommand = {
  // Whether these arguments are an invocation of this command at all — checked BEFORE the dispatch
  // claims the input, because the first word of a task is not a command. The dispatch splits the
  // task on whitespace and looks up token one, so `seri "/undo the rename and try again"` was
  // hijacked and died in the step parser with the task never sent, and `seri "/mode is broken, fix
  // it"` — an ordinary task before the table existed — went the same way. The command forms are
  // exact and small, so anything outside them falls through to the model, which is the only
  // direction that cannot silently swallow work.
  accepts: (args: string[]) => boolean;
  // Whether this command mutates the checkpoint store or truncates session.messages, either of
  // which a still-in-flight turn can silently undo or corrupt (a mid-turn /rewind truncating
  // messages only for the next messages-updated, from that same in-flight turn, to replace the
  // whole array wholesale, erasing the truncation; /undo and /restore mutate files on disk while
  // a tool may be mid-write) — runTui's onSubmit reads this field to gate the command while a
  // turn is running (MEDIUM-3). Undefined (not `false`) for every command that doesn't need it,
  // /mode included: /mode never touches a file or the checkpoint store, and live mid-turn gating
  // (C-1) is the whole point of letting it run while a turn is in flight. A field on the SAME
  // table a command is already defined in, not a second Set restating the command strings
  // elsewhere (this table's own comment above: "One table, so a new one is added in exactly one
  // place") — a future command that mutates run state can't get silently left ungated by being
  // added here and nowhere else.
  mutatesRunState?: true;
  scopeTargetToCwd?: true;
  readsDetailFlag?: true;
} & (
  | {
      needsSession?: true;
      run: (
        session: SessionState<ModelMessage>,
        args: string[],
        dirs: CommandDirs,
        presenter?: CommandPresenter,
        deps?: CliDeps,
      ) => void | Promise<void>;
    }
  | {
      needsSession: false;
      run: (
        args: string[],
        dirs: CommandDirs,
        presenter?: CommandPresenter,
        deps?: CliDeps,
      ) => void | Promise<void>;
    }
);

function requireSessionMeta(name: string): Extract<CommandMeta, { surface: "session" }> {
  const meta = commandByName(name);
  if (meta === undefined || meta.surface !== "session") {
    throw new Error(`${name} is not a session command`);
  }
  return meta;
}

function sessionSlash(
  name: string,
  run: Extract<SlashCommand, { needsSession?: true }>["run"],
): [string, SlashCommand] {
  const meta = requireSessionMeta(name);
  if (meta.needsSession === false) {
    throw new Error(`${name} is session-less; use sessionSlashNoSession`);
  }
  return [
    name,
    {
      accepts: meta.accepts,
      run,
      ...(meta.mutatesRunState === true ? { mutatesRunState: true as const } : {}),
      ...(meta.scopeTargetToCwd === true ? { scopeTargetToCwd: true as const } : {}),
      ...(meta.readsDetailFlag === true ? { readsDetailFlag: true as const } : {}),
    },
  ];
}

function sessionSlashNoSession(
  name: string,
  run: Extract<SlashCommand, { needsSession: false }>["run"],
): [string, SlashCommand] {
  const meta = requireSessionMeta(name);
  if (meta.needsSession !== false) {
    throw new Error(`${name} requires a session`);
  }
  return [
    name,
    {
      accepts: meta.accepts,
      needsSession: false,
      run,
      ...(meta.mutatesRunState === true ? { mutatesRunState: true as const } : {}),
      ...(meta.readsDetailFlag === true ? { readsDetailFlag: true as const } : {}),
    },
  ];
}

// Commands that operate on the resume target rather than being a task for the model. The name
// list lives in commandCatalog.ts; this Map is the session slice plus each command's run.
//
// A Map rather than an object literal, because an object literal inherits Object.prototype and a
// lookup keyed on user input walks it: `SLASH_COMMANDS["toString"]` returned a function, so
// `seri "toString is wrong on User, fix it"` dispatched Object.prototype.toString against the most
// recent session, printed nothing and exited 0 — the task never reached the model. `constructor`,
// `valueOf`, `hasOwnProperty` and `isPrototypeOf` did the same, and `__proto__` resolved to an
// object and crashed with "command is not a function". A Map has no prototype chain to walk, so
// the hazard is gone from every call site rather than from the ones that remember Object.hasOwn.
export const SLASH_COMMANDS = new Map<string, SlashCommand>([
  sessionSlash("/mode", cycleModeCommand),
  sessionSlash("/effort", effortCommand),
  sessionSlash("/undo", undoCommand),
  sessionSlash("/restore", restoreCommand),
  sessionSlash("/rewind", rewindCommand),
  sessionSlash("/clear", clearCommand),
  sessionSlash("/compact", compactCommand),
  sessionSlashNoSession("/memory", memoryCommand),
  sessionSlashNoSession("/trajectory", trajectoryCommand),
  sessionSlashNoSession("/usage", usageCommand),
]);

for (const meta of sessionMeta()) {
  if (!SLASH_COMMANDS.has(meta.name)) {
    throw new Error(`SLASH_COMMANDS missing ${meta.name}`);
  }
}

// The non-interactive presenter: exactly what every command printed inline before this refactor
// (console.log, plus undoPlanLines/recoveryLines — via their own default console.log sink — for
// /undo and /restore) — used when a session command runs without a TUI presenter. A factory, not a
// plain object, because `sessionUpdated` now owns persistence (CommandPresenter's own comment) and
// needs `dirs` to call saveSession with — closed over here rather than threaded through a second
// way. `onPlan` is what makes the console path print the plan BEFORE undoFiles/restoreCommit
// mutate anything, restoring output.ts's own documented guarantee.
function consolePresenter(
  dirs: CommandDirs,
  // Only /compact ever calls `.currentSession()`, and only compactCommand's own default parameter
  // (below) passes one — every other command's `consolePresenter(dirs)` call site omits it and
  // never invokes the field, so the cast in `currentSession` below is safe by construction, the
  // same shape as compactCommand's own `cancelledSignal` cast.
  session?: SessionState<ModelMessage>,
): CommandPresenter {
  return {
    message: (text) => console.log(text),
    onPlan: (plan) => undoPlanLines(plan),
    restore: ({ plan, message }) => {
      console.log(message);
      if (plan.restored.length > 0 || plan.deleted.length > 0) recoveryLines(plan);
    },
    // Trivially awaitable: saveSession is already synchronous, so this settles on the same tick
    // it is called — `async` only to satisfy CommandPresenter's own contract (its comment).
    sessionUpdated: async (next) => saveSession(next, dirs.sessionsDir),
    // Explicit no-op, not an ANSI screen-clear: the user's own scrollback is not seri's to erase,
    // and clearing it would corrupt piped/redirected output.
    transcriptCleared: () => {},
    usageAccrued: (usage) =>
      printUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
    cancelled: (signal) => {
      console.log("Compaction cancelled.");
      raiseSignal(signal);
    },
    currentSession: () => session as SessionState<ModelMessage>,
  };
}

async function cycleModeCommand(
  session: SessionState<ModelMessage>,
  _args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter = consolePresenter(dirs),
): Promise<void> {
  const { next, message } = decideModeCycle(session);
  // Awaited even though /mode has nothing of its own to sequence after sessionUpdated (unlike
  // /rewind's recordBarrier): sessionUpdated is `async` now, so a saveSession failure surfaces as
  // a promise rejection instead of a synchronous throw, and this function's own callers only
  // catch the latter — awaiting is what keeps that failure reaching them at all, not a change in
  // when persistence happens.
  await presenter.sessionUpdated(next);
  presenter.message(message);
}

async function applyEffortResult(
  session: SessionState<ModelMessage>,
  result: EffortCommandResult,
  presenter: CommandPresenter,
): Promise<void> {
  if (result.changed) {
    await presenter.sessionUpdated({ ...session, reasoningEffort: result.reasoningEffort });
  }
  presenter.message(result.message);
}

async function applyEffortCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  catalog: ModelCatalog,
  plan: Plan | null,
  configDir: string,
  presenter: CommandPresenter,
): Promise<void> {
  const configured = configuredProviders(configDir);
  const route = resolveSessionRoute(session, catalog, configured, plan, configDir);
  const legalTiers = resolveLegalReasoningTiers(route, catalog);
  const current = resolveReasoningEffort(session, loadConfig(configDir));

  const result = resolveEffortCommand(args, legalTiers, current);
  await applyEffortResult(session, result, presenter);
}

// `auto` skips both fetches entirely: resolveEffortCommand ignores `legalTiers`/`current` for that
// form, so awaiting `getModelCatalog()`/`fetchAccountPlan()` first would just be discarded latency.
async function effortCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter = consolePresenter(dirs),
): Promise<void> {
  if (args[0] === "auto") {
    await applyEffortResult(session, resolveEffortCommand(args, [], undefined), presenter);
    return;
  }
  // `Promise.all`, not two sequential `await`s: the catalog fetch and the plan fetch are
  // independent, the same reasoning prepareSession's own identical pair already applies.
  // fetchAccountPlan's own login guard skips the network call entirely for a BYOK-only/logged-out
  // session, so the common case pays nothing extra for this.
  const [catalog, plan] = await Promise.all([getModelCatalog(), fetchAccountPlan(dirs.configDir)]);
  await applyEffortCommand(session, args, catalog, plan, dirs.configDir, presenter);
}

// The step the user asked for, not the record's `seq`. `seq` is the 0-based index of a tool
// record while `/undo n` is 1-based over DISTINCT trees, so the two only ever agreed by
// accident: the first checkpoint printed "checkpoint 0", and over records [T0, T1, T1, T2]
// `/undo 2` printed "checkpoint 2" while restoring the state that preceded tool call 1. A
// number a user is shown has to be one they can hand back to the command that showed it.
//
// A step count is absolute — the n-th most recent distinct checkpoint — not relative to wherever
// a previous undo left the worktree, so `/undo 1` run three times aims at the same checkpoint
// three times. Measured before this: each of the three printed that it had undone and minted a
// fresh recovery commit while the file stayed exactly where the first one put it. Saying so is
// the same honesty `/rewind`'s "dropped 0 message(s)" already applies.
//
// Decision (decideUndo, tui/commands.ts) and presentation (the presenter) are split here per the
// research spec — the decision function wraps checkpoint.ts's undoFiles unchanged.
function undoCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter = consolePresenter(dirs),
): void {
  presenter.restore(decideUndo(session, args, dirs, presenter.onPlan));
  dirs.trajectory?.recordCheckpoint({ op: "pre-undo" });
}

// The other end of what /undo and /restore print: put the worktree back to a commit this session
// recorded. It exists so recovery is a command that reuses the restore path — removal pass
// included — rather than a git incantation the user pastes and hopes about.
function restoreCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter = consolePresenter(dirs),
): void {
  presenter.restore(decideRestore(session, args, dirs, presenter.onPlan));
  dirs.trajectory?.recordCheckpoint({ op: "pre-undo" });
}

async function rewindCommand(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter = consolePresenter(dirs),
): Promise<void> {
  const { next, message, recordBarrier } = decideRewind(session, args, dirs);
  // Awaited — genuinely, not just called and moved on from. Code review found the previous
  // version of this fix was not actually ordered on the TUI path: tuiPresenter's sessionUpdated
  // only ever dispatched, so "called AFTER sessionUpdated" was not "called after persistence"
  // there, and a crash in that window could still leave a durably-recorded barrier pointing at a
  // truncation that never reached disk. sessionUpdated's own promise (CommandPresenter's own
  // comment) now does not settle until the write actually happens on both paths, so awaiting it
  // here is what makes this genuinely ordered rather than only appearing to be.
  await presenter.sessionUpdated(next);
  // Not wrapped in its own try/catch: a failure here propagates out to the SAME try/catch every
  // slash command's own `run` already sits inside (onSubmit's) — the
  // truncation is already persisted by this point, so surfacing the failure as this command's own
  // error, rather than silently swallowing it the way driveLoop's compaction-barrier warning
  // does, is the more honest signal: the barrier itself did not land, and a later /rewind may not
  // be able to cross this point.
  if (recordBarrier()) dirs.trajectory?.recordCheckpoint({ op: "rewind-barrier" });
  presenter.message(message);
}

// /compact: the same findSafeEvictionBoundary/compactMessages the automatic path (loop.ts) uses,
// run on demand. Not a pure decide-then-present function like rewindCommand's decideRewind:
// resolving a live model and calling compactMessages are both real I/O, so this stays one `async`
// function rather than forcing a split that would fight nothing but "no speculative abstraction."
async function compactCommand(
  session: SessionState<ModelMessage>,
  _args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter = consolePresenter(dirs, session),
  deps: CliDeps = {},
): Promise<void> {
  const evictBoundary = findSafeEvictionBoundary(
    session.messages,
    DEFAULT_PRESERVE_RECENT_MESSAGES,
  );
  if (evictBoundary === null) {
    presenter.message("Not enough history to compact.");
    return;
  }
  presenter.message("⚙ compacting…");

  const configDir = deps.authConfigDir ?? getConfigDir();
  // session.model is optional (a session written before the field existed) — backfilled the same
  // way loadOrCreateSession's own resume branch does for that case: `model`/`provider` together,
  // via resolveDefaultModel(), never independently (that function's own comment explains why a
  // persisted non-groq default model paired with a hardcoded DEFAULT_PROVIDER would call the wrong
  // provider's API). DEFAULT_PROVIDER is applied afterward, uniformly, only to fill in a provider
  // that is still absent once the pair has been resolved — resolveRoute needs a concrete provider,
  // but that is a routing-time default, not a second, independent backfill of the pair itself.
  const requested =
    session.model === undefined
      ? resolveDefaultModel(configDir)
      : { model: session.model, provider: session.provider };
  const { model } = await resolveModelRoute(requested, configDir, session.id, deps, printWarning);

  const controller = new AbortController();
  let cancelledSignal: NodeJS.Signals | undefined;
  const unregisterCancel = onSignalCancel((signal) => {
    cancelledSignal = signal;
    controller.abort();
  });
  let compacted: Awaited<ReturnType<typeof compactMessages>>;
  try {
    compacted = await compactMessages(session.messages, model, evictBoundary, controller.signal);
  } catch (err) {
    // `cancelledSignal` is guaranteed defined here: `controller.signal.aborted` is only ever set
    // by the onSignalCancel callback above.
    if (controller.signal.aborted) {
      presenter.cancelled(cancelledSignal as NodeJS.Signals);
      return;
    }
    throw err;
  } finally {
    unregisterCancel();
  }

  // `presenter.currentSession()`, not this function's own `session` parameter: the two awaits
  // above (the catalog/plan fetch, the summarizer's own round trip) are a real window in which
  // /mode can run — it is deliberately exempt from the `turnInFlight` gate that blocks every other
  // mutating command (SlashCommand's own comment on why) — and spreading this function's own
  // pre-await `session` back out would silently revert whatever /mode changed in that window.
  // CommandPresenter's own comment on `currentSession` has the full account.
  await presenter.sessionUpdated({ ...presenter.currentSession(), messages: compacted.messages });
  const { storeDir } = checkpointTarget(session, dirs);
  try {
    appendBarrier(storeDir, session.id, "compaction");
    dirs.trajectory?.recordCheckpoint({ op: "compaction-barrier" });
  } catch (err) {
    // Warn-and-continue, matching driveLoop's own identical compaction-barrier catch (its own
    // comment: this is the one checkpoint call deliberately outside the degrade-never-fail policy
    // every other one obeys) — not rewindCommand's throw-through. rewindCommand's own comment
    // explains why IT differs: a rewind's truncation is the only mutation that already happened by
    // that point, so a barrier failure there is the sole signal a *later* /rewind may cross a point
    // it shouldn't. Compaction's messages are already persisted the same way by the line above, but
    // the automatic path already decided a lost compaction barrier is a warning, not a crash — this
    // command runs the identical `compactMessages` that path does, so it keeps the same answer
    // rather than making its own manual invocation strictly less forgiving than the automatic one.
    printWarning(
      `could not record the compaction barrier, so /rewind may not be able to cross this point: ${messageOf(err)}`,
    );
  }
  presenter.usageAccrued(compacted.usage);
  presenter.message(`⚙ compacted ${compacted.evictedCount} messages`);
}

// /clear: starts a brand-new session in the running process. No try/catch of its own — this runs
// inside the same try/catch every slash command's `run` already sits inside (onSubmit's).
//
// Order is load-bearing. `sessionUpdated` first and awaited: it is what persists `next` (the new,
// empty session) before anything else happens, the same "await before you rely on it having
// landed" reasoning rewindCommand's own recordBarrier already depends on. `transcriptCleared`
// comes AFTER `sessionUpdated`, not before, for the same durability reason, and because
// echoUserInput (runTui's onSubmit) has already dispatched the `> /clear` echo into the transcript
// by the time this function runs — wiping after it is what removes it. `message` comes last: it is
// the confirmation the wipe must not also erase.
async function clearCommand(
  session: SessionState<ModelMessage>,
  _args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter = consolePresenter(dirs),
): Promise<void> {
  const { next, message } = decideClear(session);
  await presenter.sessionUpdated(next);
  presenter.transcriptCleared();
  presenter.message(message);
}

// Unlike /mode, /undo, /rewind and /restore, decideMemoryCommand's own I/O (config.json, the
// pending/ queue) is keyed on configDir alone — no session, hence needsSession: false on this
// entry's own SlashCommand table row and no session parameter here.
async function memoryCommand(
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter = consolePresenter(dirs),
): Promise<void> {
  const { lines } = decideMemoryCommand(args, { configDir: dirs.configDir });
  for (const line of lines) presenter.message(line);
}

function trajectoryCommand(
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter = consolePresenter(dirs),
): void {
  const currentlyEnabled =
    dirs.trajectory?.isEnabled() ?? loadTrajectoryConfig(dirs.configDir).enabled;
  const decided = decideTrajectoryCommand(args, currentlyEnabled);
  if (decided.enabled !== undefined) {
    setConfigValue("SERI_TRAJECTORY_ENABLED", decided.enabled ? "true" : "false", dirs.configDir);
    dirs.trajectory?.setEnabled(decided.enabled);
  }
  let message = decided.message;
  if (decided.enabled !== undefined && process.env.SERI_TRAJECTORY_ENABLED !== undefined) {
    message +=
      " SERI_TRAJECTORY_ENABLED in the environment will still win the next time you start seri.";
  }
  presenter.message(message);
}

async function usageCommand(
  args: string[],
  dirs: CommandDirs,
  presenter: CommandPresenter = consolePresenter(dirs),
  deps?: CliDeps,
): Promise<void> {
  const fn = deps?.usageCommand ?? runUsageCommandReal;
  await fn(dirs.configDir, {
    detail: args[0] === "--detail",
    presenter,
  });
}

// One readline prompt per approval, opened and closed on demand, so a task that never
// needs approval (read-only/auto modes) never touches stdin at all.
//
// Two wires into the same cancel, because a Ctrl-C at this prompt is not delivered the way a
// Ctrl-C during streaming is. Measured on a real pty, all three candidate handlers registered while
// rl.question was up, one real 0x03 sent: rl's SIGINT fired, rl's close fired, and
// process.on("SIGINT") NEVER fired. Readline in terminal mode puts stdin in raw mode, so the tty
// stops generating the signal for the process and hands the byte over as data; readline emits the
// event on the INTERFACE instead. With nothing listening there, readline closes itself, the
// question's callback never runs, the event loop empties and the process is simply gone — with the
// turn's tool calls persisted and no tool-result row, i.e. AI_MissingToolResultsError on the next
// --resume. Reproduced end to end on the compiled binary before this listener existed.
//
// So rl's SIGINT is routed into deliverSignal — signals.ts's own entry point, the one its
// process-level listener uses — rather than into a second copy of the cancel rules that would
// drift from it. The first press spends the single cancel slot and cli.ts unwinds the turn; a
// second press finds the slot empty and takes the fatal path, exactly as it would mid-stream —
// and it gets there as a real process signal rather than through this interface, because the abort
// listener below closes the readline, which puts the tty back out of raw mode and lets it generate
// SIGINT again.
//
// The onAbort registration is the other direction: a cancel that originated elsewhere while the
// prompt is up. Closing the interface and resolving "no" is what unparks the turn. The loop tells
// that "no" apart from a typed "n" by re-checking the signal, so the row the model sees says the
// call was cancelled rather than denied. A signal that is already aborted returns before the
// interface is opened — onAbort would catch that case too, that being the whole point of it, but a
// turn that has already been cancelled should not touch stdin to find out.

// Whichever of the two is still a terminal. stdout carries the model's own output and is
// routinely piped (`seri "…" | tee log`) — see printWarning's own comment in cli/output.ts, the
// same rule — which is why this used to be stderr unconditionally. But stderr redirects just as
// often (`seri "…" 2> errors.log`), and moving to stderr traded one broken pipe for another: the
// question lands in the log file and the terminal goes blank while the run blocks on stdin.
// Checking stderr first, then stdout, then falling back to stderr covers both redirection shapes
// (whichever stream is NOT redirected is where the question renders) and reproduces today's
// behaviour when neither is a terminal, where it makes no difference which is picked.
export function chooseInterfaceOutput(): NodeJS.WritableStream {
  return process.stderr.isTTY
    ? process.stderr
    : process.stdout.isTTY
      ? process.stdout
      : process.stderr;
}

function makeApprovalPrompt(
  // Reads only from `input`, unchanged.
  openInterface: () => Interface = () =>
    createInterface({ input: process.stdin, output: chooseInterfaceOutput() }),
): ApprovalPrompt {
  // Once true, no further prompt in this run touches stdin at all. `process.stdin` is a single
  // shared stream that only ever emits 'end' once: the FIRST prompt's Interface is what actually
  // starts consuming it and discovers EOF, so its 'close' listener is the only one that will ever
  // fire. A second Interface opened on the same, already-ended stream attaches its own listeners
  // AFTER 'end' already happened — EventEmitters do not replay past events to a late listener — so
  // its 'close' never fires and its question's callback never runs: the promise hangs forever.
  // Measured live: prompt 1 resolves "no" correctly, prompts 2 and beyond hang. Denying every
  // prompt after the first EOF, without opening a doomed second Interface to rediscover that, is
  // Hermes' own rule for this applied at the point where it costs nothing extra to check first —
  // "on timeout or error, the approval bridge denies the request." Deliberately not a TTY check:
  // that would also kill `seri "explain this repo" | tee log`, a non-interactive run that only
  // reads and needs no approval at all; this only engages once stdin has actually ended.
  let ended = false;

  return (toolName, args, signal) =>
    new Promise<ApprovalAnswer>((resolve) => {
      if (signal?.aborted === true || ended) {
        resolve("no");
        return;
      }
      // A positive list, where the old bash/powershell exclusion set was a negative one: a write
      // tool added to the gate must be opted in to permanent approval deliberately. Today the two
      // sets pick out the same names for every input that can reach here (a read tool never
      // reaches the prompt at all), so this is a change of source of truth, not of behaviour.
      const offersAlways = PERSISTABLE_TOOLS.has(toolName);
      let answered = false;
      const rl = openInterface();
      const abort = onAbort(signal, () => {
        answered = true;
        rl.close();
        resolve("no");
      });
      rl.on("close", () => {
        if (!answered) {
          answered = true;
          // readline's tty path also calls close() on Ctrl-D at an empty line — verified directly
          // against Node's readline implementation: this fires 'close' WITHOUT the underlying
          // stream ending (input.readableEnded stays false). Latching `ended` on any 'close' would
          // treat "stop asking about THIS one" (Ctrl-D) as "stop asking for the rest of the run"
          // (real EOF) — the user hits Ctrl-D once and sees every later prompt silently deny
          // itself with nothing rendered, until repeated-denials kills the run. Latch only when
          // the input actually ended, so a fresh Interface after a Ctrl-D still works.
          if (inputHasEnded(rl)) ended = true;
          abort.dispose();
          resolve("no");
        }
      });
      rl.on("SIGINT", () => deliverSignal("SIGINT"));
      rl.question(approvalPromptText(toolName, args, offersAlways), (answer) => {
        answered = true;
        abort.dispose();
        rl.close();
        const typed = answer.trim().toLowerCase();
        // Anything unrecognised is "no", exactly as the old [y/N] parse treated it: an approval a
        // user did not clearly give is not an approval. An "a"/"always" typed at a shell prompt
        // (not offered, see PERSISTABLE_TOOLS) is "unrecognised" by the same rule, not a special case.
        const wantsAlways = offersAlways && (typed === "a" || typed === "always");
        resolve(typed === "y" || typed === "yes" ? "once" : wantsAlways ? "always" : "no");
      });
    });
}

// readline.Interface stores the stream it was built from as `.input`, undocumented in @types/node
// (only the ReadLineOptions shape that CONSTRUCTS an Interface is typed, not the instance's own
// field) but stable at runtime — verified directly against Node's readline implementation.
function inputHasEnded(rl: Interface): boolean {
  return (
    (rl as unknown as { input: NodeJS.ReadableStream & { readableEnded?: boolean } }).input
      .readableEnded === true
  );
}

const PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  selftest: { type: "boolean" },
  resume: { type: "string" },
  continue: { type: "boolean" },
  "max-turns": { type: "string" },
  "dangerously-skip-permissions": { type: "boolean" },
  profile: { type: "string" },
} as const;

type ParsedArgs = {
  values: {
    help?: boolean;
    version?: boolean;
    selftest?: boolean;
    resume?: string;
    continue?: boolean;
    "max-turns"?: string;
    "dangerously-skip-permissions"?: boolean;
    profile?: string;
  };
  positionals: string[];
  maxTurns: number | undefined;
  skipPermissions: boolean;
};

// One convention across every handler below, so `run` reads as the sequence it is: a `number` is
// "handled, and this is seri's exit code", `undefined` is "not mine, carry on". The order they are
// called in is the behaviour — each was a guard clause inside one function before, and the three
// orderings that are load-bearing are named at their call sites.
function parseCliArgs(argv: string[]): ParsedArgs | number {
  let values: ParsedArgs["values"];
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: PARSE_OPTIONS,
    }));
  } catch (err) {
    return usageError(messageOf(err));
  }

  // Set here, before any validation below that can return a usage error early: every call to
  // parseCliArgs must reset the override to what THIS invocation's flag says (undefined if none),
  // so a usage error from an unrelated flag (e.g. a malformed --max-turns) can never leave a
  // PREVIOUS successful run()'s --profile leaked into the next in-process run() call — bun test
  // runs many run() calls in a single process, and a future fixed-process TUI/REPL loop will too.
  setProfileOverride(values.profile);

  const maxTurnsRaw = values["max-turns"];
  let maxTurns: number | undefined;
  if (maxTurnsRaw !== undefined) {
    // parseArgs accepts --max-turns abc happily (measured) — it has no numeric option type — so
    // this check is not redundant. Same shape as /undo's `[n]` accepts. Validated here, right after the
    // parse, so a malformed value is a usage error regardless of which verb follows it —
    // `seri --max-turns garbage serve` used to reach serve with the bad flag silently ignored.
    if (!/^[1-9]\d*$/.test(maxTurnsRaw))
      return usageError(`Invalid --max-turns value: ${maxTurnsRaw}`);
    maxTurns = Number(maxTurnsRaw);
  }

  // Validated here too, right after the parse: an invalid profile from either source is a usage
  // error, not a silent fallback to "default" — the alternative would write a user's sessions and
  // auth into the tree they believed they were isolated from.
  const { profile, source } = resolveProfile(values.profile);
  const profileError = profileNameError(profile);
  if (profileError !== undefined) {
    const named = source === "flag" ? "--profile" : "SERI_PROFILE";
    return usageError(`Invalid ${named} value: ${profile} — ${profileError}`);
  }

  // `--resume` now takes a mandatory value, so a slash command after it (`seri --resume /mode`,
  // the form `--resume`'s old optional-value parsing used to cycle the most recent session's mode)
  // looks for a session literally named "/mode" and fails with "session not found" instead — a
  // silent behaviour change rather than a loud one. Caught here as a usage error naming the fix.
  if (values.resume !== undefined && SLASH_COMMANDS.has(values.resume)) {
    return usageError(
      `--resume ${values.resume} looks for a session named "${values.resume}". Did you mean: seri --continue ${values.resume}`,
    );
  }

  return {
    values,
    positionals,
    maxTurns,
    skipPermissions: values["dangerously-skip-permissions"] === true,
  };
}

function handleInfoFlags(values: ParsedArgs["values"]): number | undefined {
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  if (values.version === true) {
    console.log(`seri ${pkg.version}`);
    return 0;
  }
  return undefined;
}

// Undocumented build-verification flag: the embedded ripgrep is vendored for the build
// host, so a cross-compiled binary can ship one that cannot run on the target. Spawning
// it for real is the only way to catch that from a shipped artifact; the release workflow
// runs this on every platform. Greps a throwaway file rather than the cwd so the result
// never depends on what happens to be in the directory seri was launched from.
async function runSelftest(deps: CliDeps): Promise<number> {
  const grepFn = deps.grep ?? grepReal;
  try {
    const dir = mkdtempSync(join(tmpdir(), "seri-selftest-"));
    try {
      writeFileSync(join(dir, "probe.txt"), "seri selftest probe\n");
      const { matches = [] } = await grepFn("selftest probe", { path: dir, mode: "content" });
      if (matches.length !== 1)
        throw new Error(`ripgrep returned ${matches.length} matches, expected 1`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Names the version, because "it worked" leaves the one thing a cross-compiled artifact can
    // get wrong — which rg was actually vendored for this target — unsaid.
    console.log(`selftest ok: ripgrep ${rgVersion(resolveRg())}`);
    return 0;
  } catch (err) {
    console.error(messageOf(err));
    return 1;
  }
}

async function handleServeCommand(
  positionals: string[],
  deps: CliDeps,
): Promise<number | undefined> {
  if (positionals[0] !== "serve") return undefined;
  if (positionals.length !== 1) {
    return usageError("seri serve takes no arguments");
  }
  const configDir = deps.authConfigDir ?? getConfigDir();
  const start = deps.startDaemon ?? startDaemonReal;
  try {
    const daemon: StartedDaemon = await start({
      configDir,
      executeTurn: deps.executeTurn,
      runScheduled: deps.runScheduled,
      onIdleFlush: deps.onIdleFlush,
      deps,
    });
    console.log(`seri daemon listening on ${daemon.endpoint}`);
    try {
      if (deps.waitForServe !== undefined) await deps.waitForServe();
      else {
        // signals.ts installs process SIGINT/SIGTERM listeners at import time. SIGTERM always
        // takes that file's fatal path (cleanups, then re-raise) and never the cancel slot, so a
        // `process.once("SIGTERM")` registered here would not run: the fatal listener is already
        // first and raiseSignal removes every listener before this wait could resolve. A
        // foreground daemon must stop the server, cancel turns, and remove its own descriptor
        // before exiting, so this process replaces those listeners for the wait only.
        process.removeAllListeners("SIGINT");
        process.removeAllListeners("SIGTERM");
        await new Promise<void>((resolve) => {
          process.once("SIGINT", () => resolve());
          process.once("SIGTERM", () => resolve());
        });
      }
    } finally {
      await daemon.stop();
    }
    return 0;
  } catch (err) {
    console.error(messageOf(err));
    return 1;
  }
}

async function handleExecCommand(
  positionals: string[],
  deps: CliDeps,
): Promise<number | undefined> {
  if (positionals[0] !== "exec") return undefined;
  const task = positionals.slice(1).join(" ").trim();
  if (task.length === 0) return usageError("seri exec requires a task");
  const configDir = deps.authConfigDir ?? getConfigDir();
  const descriptor = readDaemonDescriptorFile(configDir);
  if (descriptor === undefined) {
    console.error("no daemon is running for this profile — start one with seri serve");
    return 1;
  }
  const client = new DaemonClient({
    endpoint: descriptor.endpoint,
    token: descriptor.token,
    fetch: deps.fetch,
  });
  let exitCode: 0 | 1 = 1;
  let turnId: string | undefined;
  let cancelRequested = false;
  const unregisterCancel = onSignalCancel(() => {
    cancelRequested = true;
    if (turnId !== undefined) void client.cancel(turnId).catch(() => {});
  });
  try {
    for await (const event of client.startTurn({ task, cwd: process.cwd() })) {
      turnId = event.turnId;
      if (cancelRequested) {
        await client.cancel(turnId);
        cancelRequested = false;
      }
      if (event.event.type === "approval-request" && typeof event.event.requestId === "string") {
        await client.approve(turnId, event.event.requestId, "no");
        continue;
      }
      if (isLoopDaemonEvent(event.event)) printEvent(event.event.value as LoopEvent);
      if (event.event.type === "turn-complete" && "exitCode" in event.event) {
        const code = event.event.exitCode;
        if (code === 0 || code === 1) exitCode = code;
      }
    }
  } catch (err) {
    console.error(messageOf(err));
    return 1;
  } finally {
    unregisterCancel();
  }
  return exitCode;
}

// What the task path needs after serve/exec have had their say. It extends CommandDirs, so it
// satisfies the two callees that take one structurally — but it is not handed to them whole:
// `dirs(ctx)` below narrows it back down at each call. Structural typing makes passing the whole
// thing legal and silent, so a slash command handler that asks for two directories would in fact
// receive the resume target and the task text as well — and whatever it grew to read from them
// would still typecheck against a signature saying it needs neither. Narrowing at the call site is
// what keeps the callee's declared contract the true one.
export type RunContext = CommandDirs & {
  resuming: boolean;
  resumeId: string | undefined;
  taskText: string;
  permissionsDir: string;
  // Explicit working directory for a new session. Direct CLI/TUI callers pass process.cwd(); the
  // daemon passes the session's stored cwd and never calls process.chdir.
  cwd: string;
};

// Shared by confirmedModel's and lastPersistedModel's own guards (both inside runTui, below) —
// hand-duplicating `a.model !== b.model || a.provider !== b.provider` at each site was the same
// comparison typed twice with two different variable names.
function modelPairChanged(
  a: { model: string; provider: ModelProvider },
  b: { model: string; provider: ModelProvider },
): boolean {
  return a.model !== b.model || a.provider !== b.provider;
}

// A plain default-flush transcript-append, shared by tuiPresenter's own `append` below and
// runTui's quit() — the only two places that dispatch this exact shape rather than something with
// its own `> `/`flush: false` handling (echoUserInput, a different shape entirely, is not this).
function pushTranscriptLine(
  dispatch: Dispatch,
  line: string,
  opts?: { muted?: boolean; markdown?: boolean },
): void {
  dispatch({ type: "transcript-append", line, muted: opts?.muted, markdown: opts?.markdown });
}

// The TUI's presenter: the same `{message}`/`{plan, message}` shapes tui/commands.ts's decision
// functions return, dispatched into the live transcript instead of printed. Calls the SAME
// undoPlanLines/recoveryLines output.ts uses for the console path (M-6: these used to be a
// hand-copied duplicate of those two functions' line shapes, which could drift out of sync the
// moment one changed and the other did not), with a sink that dispatches a transcript-append
// action per line instead of output.ts's own default console.log.
// `awaitPersist` is runTui's own awaitNextPersist (its own comment explains the queue) — what
// makes `sessionUpdated` genuinely await the reducer's own onSessionChange effect actually
// persisting, not just dispatching, fixing the gap code review found in the previous round's
// finding-9 fix (this file's own CommandPresenter comment has the full account).
export function tuiPresenter(
  dispatch: Dispatch,
  awaitPersist: () => Promise<void>,
  // CommandPresenter's own comment on `currentSession`: the live `liveState.session` read fresh at
  // persist time, not a closure's stale copy — required (not defaulted, unlike `onUsageAccrued`
  // below) because there is no neutral session a default could return, and every call site already
  // has a `liveState` of its own to read from.
  getSession: () => SessionState<ModelMessage>,
  // /compact's usage fold: tuiPresenter does not itself close over runTui's usage/cost `let`s
  // (those live in a different function), so the fold is supplied by the caller instead. Defaults
  // to a no-op for every call site but the two that go through command.run inside onSubmit.
  onUsageAccrued: (usage: LanguageModelUsage) => void = () => {},
): CommandPresenter {
  const append = (line: string): void => pushTranscriptLine(dispatch, line);
  return {
    message: append,
    onPlan: (plan) => undoPlanLines(plan, append),
    restore: ({ plan, message }) => {
      append(message);
      if (plan.restored.length > 0 || plan.deleted.length > 0) recoveryLines(plan, append);
    },
    sessionUpdated: (next) => {
      const persisted = awaitPersist();
      dispatch({ type: "session-updated", session: next });
      return persisted;
    },
    transcriptCleared: () => dispatch({ type: "transcript-cleared" }),
    usageAccrued: onUsageAccrued,
    // No signal re-raise, unlike consolePresenter: matches the LOW-J precedent (runTurn's own
    // comment) that a per-turn cancel on the TUI path returns control to the input prompt rather
    // than killing the process.
    cancelled: () => append("Compaction cancelled."),
    currentSession: getSession,
  };
}

function checkZeroKeysConfigured(configDir: string): boolean | number {
  try {
    return configuredProviders(configDir).size === 0;
  } catch (err) {
    // The alt screen is still active here (entered by run()'s own isTTY block, above), and this
    // message is terminal for the run — nothing re-enters it after this catch returns. No
    // `preMountMessages` to flush: this runs before `prepareSession` (the only thing that queues
    // any) is ever called.
    return fatalDuringTui(err);
  }
}

// Mounted only when deps.isTTY is true (run()'s own branch, above driveLoop's other call site —
// see CliDeps.isTTY's own comment for why that reads a passed-in flag, not a live
// process.stdout.isTTY). Drives the SAME driveLoop the non-interactive path uses for the initial
// task already appended to `prepared.session.messages` by prepareSession — only how it reports
// events differs.
//
// `ink`/`react` used to be imported lazily here rather than at this file's top level: Ink's own
// reconciler.js had a module-load-time check — `if (process.env['DEV'] === 'true') { …; await
// import('./devtools.js'); }`, unconditional, not gated behind an actual render() call — so a
// top-level `import … from "ink"` ran that check (and attempted a react-devtools-core connection
// under DEV=true) on every invocation of this binary, `seri --version` and every piped/
// non-interactive command included, regardless of whether this function is ever reached.
// `@opentui/react` has no equivalent module-load-time check (checked its compiled source
// directly — no `process.env` read anywhere in it), so that reason no longer applies; `App`,
// `createElement`, and `@opentui/react`'s own root/hooks are plain top-level imports now.
async function runTui(
  prepared: PreparedRun,
  ctx: RunContext,
  deps: CliDeps,
  maxTurns: number | undefined,
  skipPermissions: boolean,
): Promise<DriveLoopResult> {
  // `root` is awaited here, at the top of this function, instead of at a synchronous `render()`
  // call: `createCliRenderer` is async (`@opentui/core`'s own API, unlike Ink's synchronous
  // `render`), so
  // `renderer`/`root` are obtained and awaited before anything else in this closure runs, not just
  // before the promise executor — every closure below (`quit`, `runTurn`'s catch) can only ever
  // execute from a keypress or reducer effect, neither of which can fire before this `await`
  // resolves and the tree is actually mounted.
  const { renderer, root } = await getTuiRenderer();

  // Matches prepareSession's own resolution (D7, feature-plan.md) — routing-priority's per-turn
  // re-resolution (runTurn, below) and /setup's own reads/writes (a later commit in this loop)
  // both need it, and both must agree with prepareSession on where "the config dir" is.
  const configDir = deps.authConfigDir ?? getConfigDir();

  // Findings 2/3/4/6 (thermo-nuclear structural review, round 6): `liveState` is a SYNCHRONOUS
  // mirror of the reducer's own state, kept current by running the exact same pure `tuiReducer`
  // function here, in `dispatch` below, every time ANY caller in this closure dispatches an
  // action — the identical computation React's own `useReducer` (App.tsx) will ALSO run against
  // its OWN copy, moments later. Every read in this file that used to go through `liveSession` (a
  // value only ever refreshed by `onSessionChange`, which only fires from App.tsx's own
  // `useEffect(() => onSessionChange?.(state.session), [state.session])` — a REACT EFFECT, which
  // runs asynchronously after a render commits, never synchronously with the dispatch that
  // triggered it) now reads `liveState.session` instead: the exact "caller keeps a stale copy of
  // state a pure reducer already owns" shape C-1 took five rounds to eliminate for driveLoop,
  // left standing here for the TUI's OWN reads building the NEXT action off `liveSession` — a
  // mid-run /mode's `session-updated` could revert messages the reducer had already merged
  // (finding 2), /rewind's own clamp could compute against a stale, shorter message array right
  // after a turn completed (finding 3), submitting a new task right after a turn completes could
  // silently drop that turn's own tail from what the next one sees (finding 4), and a mid-run
  // /mode's permission change was not guaranteed to take effect on the very next tool call despite
  // `getPermissionMode`'s own comment saying so (finding 6). Persistence is NOT part of this fix
  // and deliberately stays effect-driven — `onSessionChange` below still only fires from React's
  // own effect, MEDIUM-1's own accepted, documented, narrow trade-off (persistence lagging by a
  // tick) is unrelated to reads racing ahead of a stale copy, which is what this closes.

  // Computed once, here, and reused for both `liveState`'s own seed (below) and the
  // `createElement(App, ...)` mount call (this function's own `root.render` near the end) — the
  // same single-source-of-truth shape `prepared.route` already gives both of those, so the two
  // can't start out disagreeing about what config.json held at mount. Re-read fresh on every
  // config.json write afterward (`config-updated`, dispatched below and from handlers.ts); this
  // initial read only ever covers the window before the first such dispatch lands.
  const initialConfig = loadConfig(configDir);
  let liveState: TuiState = initialTuiState(prepared.session, {
    route: prepared.route,
    config: initialConfig,
  });
  // B2 fix (MEDIUM-5): the model/provider onSessionChange (below) actually WRITES to disk, kept
  // deliberately separate from `liveState.session.model`/`.provider` (what a picked model changes
  // immediately, so the next runTurn attempts it — onModelSelected's own comment) — mirrors
  // prepareSession's own "only pin a model that demonstrably worked" invariant (that function's own
  // comment), applied to a live /model switch instead of just session creation. Starts at this
  // run's own starting model/provider — already trusted the same way prepareSession trusts it for
  // turn 1 — and only ever moves forward on a genuinely successful turn (runTurn's own onEvent
  // callback, below, on `messages-updated`), never on the picker resolving by itself. A picked
  // model whose first turn errors (no working key, an unknown id) leaves this untouched, so the
  // session on disk stays pinned to the model that was last known to work — recoverable on the next
  // `--resume` — instead of a switch nothing ever confirmed.
  // D3 (feature-plan.md): initialized from `prepared.route` — the pair the run actually RESOLVED
  // to — not `prepared.session.{model,provider}`, which is only what the session REQUESTED. The
  // two can differ from turn 1 (a routing-priority reroute, D2), and starting from the requested
  // pair while turn 1 actually runs on the resolved one would trip this variable's own inequality
  // guard (below) on turn 1, persisting a switch the session never asked for and breaking the
  // "a session that never touches /model never writes config.json" invariant
  // (tuiPty.test.ts's own regression guard for this).
  let confirmedModel: { model: string; provider: ModelProvider } = {
    model: prepared.route.model,
    provider: prepared.route.provider,
  };
  // Tracks what actually LANDED in config.json, separate from `confirmedModel` above — the two
  // used to share one variable for two jobs (code-review finding on PR #71): `confirmedModel`
  // moved to the new pair BEFORE `persistDefaultModel` was even attempted, so once it had moved,
  // the runTurn's own inequality guard (below) was already satisfied for that pair and a
  // persist that failed on its first attempt (a transient EACCES/ENOSPC/read-only config dir)
  // was never retried, even though every later turn kept succeeding on that exact model. This
  // starts at the same starting pair as `confirmedModel` for the identical reason: turn 1, which
  // runs on the model the session already started on, must not attempt a persist at all.
  // Same reasoning as `confirmedModel`, just above: starts at `prepared.route`, not
  // `prepared.session`, for the identical reason.
  let lastPersistedModel: { model: string; provider: ModelProvider } = {
    model: prepared.route.model,
    provider: prepared.route.provider,
  };
  // The single tracking variable /effort's own persist-on-success gate needs — see this function's
  // own messages-updated handler (below). Unlike confirmedModel/lastPersistedModel above, there is
  // no separate "confirmed" mirror here: `session.reasoningEffort` is read directly wherever a
  // confirmed-value mirror would otherwise sit. `undefined` is a real, trackable state here (no
  // session override yet, or /effort auto cleared one), unlike the model pair, which is never
  // optional — a turn that never touches /effort must not write SERI_REASONING_EFFORT.
  //
  // Deliberately NOT cached in a local variable the way `lastPersistedModel` is (its own comment,
  // just above): SERI_MODEL/SERI_PROVIDER are never listed as /config's own known keys (/model is
  // the only live-session writer, which already flows through `lastPersistedModel`), but
  // SERI_REASONING_EFFORT is a first-class /config key (CONFIG_KEY_INFO, tui/state/commands.ts) —
  // a user can edit it directly, mid-session, through a path that never touches this closure. A
  // cached `let` seeded once at session start went stale the moment that happened: `/config` writes
  // "low" straight to config.json, the cached variable keeps saying "high", and a later `/effort
  // high` (matching the STALE cached value, not the real one) compared equal and silently skipped
  // the write — leaving config.json stuck on "low" while the session was actually running on
  // "high". Reading config.json fresh at the comparison site below removes the staleness entirely
  // — there is no cached value left to go stale, whether it's this /config bypass or a process
  // killed between a session-only /effort merge and the first turn that would have persisted it.
  // The raw `useReducer` dispatch App.tsx's own `connectDispatch` hands back — renamed from this
  // file's old, single `dispatch` variable so that name is free for the wrapper below, which is
  // what every other function in this closure actually calls now.
  let reactDispatch: Dispatch | undefined;
  // The single dispatch funnel every dispatch in this closure now goes through — driveLoop's own
  // onEvent mapping (runTurn, below), onSubmit, quit(), tuiPresenter, tuiApprovalPrompt. Updates
  // `liveState` synchronously, in the same tick as the call, BEFORE handing the same action to
  // React's own dispatch — see this function's own comment above for why that ordering is what
  // makes `liveState.session` (and, findings 1+5, `liveState.pendingApproval`) trustworthy to read
  // immediately afterward, unlike anything that waited on `onSessionChange`'s effect.
  const dispatch: Dispatch = (action) => {
    liveState = tuiReducer(liveState, action);
    reactDispatch?.(action);
  };
  // Echoes the user's own submitted text into the persistent transcript — onSubmit and
  // connectDispatch's initial-argv-task case both need this, verbatim. `flush: false`: a
  // submission this echoes can be REJECTED (e.g. MEDIUM-3's turnInFlight gate) while the model's
  // own turn keeps streaming unaffected — flushing here would fragment that in-progress answer
  // into two transcript entries for a submission that did nothing. The rejected/accepted text
  // still gets echoed either way (this whole fix's own point); only the flush side-effect is
  // skipped. Also clears a stale commandError from a PREVIOUS submission: this fires before every
  // submission's own branch runs (onSubmit's own comment), so a fresh command-error this
  // submission goes on to produce still lands afterward and is unaffected.
  const echoUserInput = (text: string): void => {
    dispatch({ type: "transcript-append", line: `> ${text.trim()}`, role: "user", flush: false });
    dispatch({ type: "command-error-cleared" });
  };
  let turnInFlight = false;
  // HIGH-B: the currently in-flight turn's own promise (a fresh one assigned at each of the two
  // call sites that start one, both guarded so a new turn is never started while one is already
  // running — see runTurn's own comment). quit() awaits this when a turn is in flight instead of
  // abandoning it, so cancelling on the way out actually unwinds before the quit sequence runs.
  // The initial value is never awaited for real: quit() only reads it when turnInFlight is true,
  // which is only ever set by an assignment to this variable first.
  let currentTurn: Promise<void> = Promise.resolve();
  // LOW-G: without this, a second /exit or Ctrl-D while quit() is already unwinding a cancelled
  // turn would re-enter finishQuit() on a renderer already mid-teardown — `destroyTuiRenderer()`
  // has no guard against a second call itself beyond its own no-op-if-already-torn-down check.
  let quitting = false;

  // HIGH-1: accumulated across every turn this TUI session runs (addTokens, the same summing
  // driveLoop itself does within one turn), not just the last one — a multi-turn session's own
  // usage/cost summary should total the whole session, not whichever turn happened to be running
  // when the user quit. `doneReason`/`refusedWithoutRunning` are NOT accumulated — the exit code
  // they drive (run()'s own logic, unchanged) is about the LAST turn's outcome, the same as it
  // always answered "did the run just now finish, and how."
  let usage: RunUsage = { inputTokens: undefined, outputTokens: undefined };
  let cost: CostReport | undefined;
  let doneReason: DriveLoopResult["doneReason"];
  let refusedWithoutRunning = false;
  // Same "last turn's outcome" reasoning as doneReason/refusedWithoutRunning, just above — a turn
  // with nothing to report simply leaves this undefined again. runTurn (below) also renders every
  // non-undefined report live into the transcript, the moment it happens, as a muted stats line
  // plus an optional muted markdown summary; this copy is what lets the FINAL resolveRunTui result
  // carry one too, printed once more after Ink unmounts, the same way `usage`/`cost` already print
  // again there.
  let archivist: ArchivistReport | undefined;
  // This closure's own copy of DriveLoopResult.ranAnyTurn (see that field's own comment) — flipped
  // true the moment runTurn actually starts a turn (not on the early-return guard below it), so an
  // idle session the user quit without ever submitting a task never flips it.
  let ranAnyTurn = false;
  // `maxTurns` (the `--max-turns` startup flag) seeds this, but `/max-turns <n>` (onSubmit, below)
  // reassigns it live — runTurn's own driveLoop call reads THIS, not the parameter, so an override
  // takes effect on the next turn with no restart.
  let liveMaxTurns = maxTurns;
  // Created ONCE per SESSION, outside the per-turn loop, so the tool-call counter accumulates
  // across every turn of that session rather than resetting each time runTurn calls driveLoop.
  // `let`, not `const`: /clear (onSubmit, below) replaces this with a fresh
  // `createArchivistState(liveState.session)` the moment it mints a new session id — a rebuild, not
  // a reset, since the new session genuinely has nothing to skip past (unlike resetArchivistForRewind's
  // own truncation-in-place, which deliberately leaves toolCallsSinceRun alone).
  let archivistState = createArchivistState(prepared.session);

  // Resolvers waiting on onSessionChange's OWN NEXT actual persist, not merely the next dispatch
  // — tuiPresenter's own sessionUpdated (round 7 code review's finding-9 fix) pushes one every
  // time it dispatches a session-updated action, via awaitNextPersist below, and onSessionChange
  // resolves and clears the whole queue once its own saveSession call for whatever session
  // actually landed has returned. This does not add a second writer — onSessionChange is still
  // the only thing that calls saveSession on the TUI path — it only makes that ONE writer's
  // completion observable to a caller that needs to sequence after it (rewindCommand's own
  // recordBarrier).
  let pendingPersistResolvers: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  function awaitNextPersist(): Promise<void> {
    return new Promise((resolve, reject) => {
      pendingPersistResolvers.push({ resolve, reject });
    });
  }

  // The single source of truth for persistence on the TUI path (C-1/MEDIUM-1's fix — see
  // driveLoop's own comment on its messages-updated case, and tui/reducer.ts's messages-updated
  // case, for the bug this replaced): App.tsx calls this whenever the reducer's own `state.session`
  // changes, for any reason — a slash command, or driveLoop's messages-updated. Persistence ONLY,
  // now — `liveState` (this function's own comment above) is what every READ goes through, kept
  // current synchronously by `dispatch`, not by this effect-driven callback.
  //
  // Round 8 code review, finding 1: saveSession used to be called bare here, with nothing to catch
  // a throw (ENOSPC, EACCES, the sessions dir removed mid-session). Every structurally equivalent
  // persistence-adjacent write elsewhere in this file (appendBarrier, rememberGrant) is wrapped in
  // try/catch + printWarning specifically so a write failure degrades gracefully — this one was
  // not, and worse: a throw here happened BEFORE the pendingPersistResolvers-draining loop, so any
  // command awaiting awaitNextPersist() (cycleModeCommand's/rewindCommand's own `await
  // presenter.sessionUpdated(next)`) hung forever instead of failing. Rejecting those resolvers
  // (rather than resolving them) also preserves finding 9's own guarantee: rewindCommand's
  // recordBarrier() is called only after its own await resolves, and a rejection means it never
  // runs — the barrier must not be recorded pointing at a truncation that never reached disk.
  function onSessionChange(session: SessionState<ModelMessage>): void {
    const resolvers = pendingPersistResolvers;
    pendingPersistResolvers = [];
    // B2 fix: writes `confirmedModel`, not `session`'s own live model/provider — see
    // `confirmedModel`'s own comment above. Every other field of `session` (messages,
    // permissionMode, …) is unaffected; only these two are ever substituted.
    const toPersist = {
      ...session,
      model: confirmedModel.model,
      provider: confirmedModel.provider,
    };
    try {
      saveSession(toPersist, ctx.sessionsDir);
    } catch (err) {
      const message = `could not save the session: ${messageOf(err)}`;
      // Not `printWarning(message)`: its default sink is `console.error`, a raw write that bypasses
      // the mounted tree entirely — found live, it corrupted whatever row the cursor was last left
      // at instead of ever reaching the transcript. `dispatch` is the only sink every other in-TUI
      // error uses.
      dispatch({ type: "command-error", message });
      for (const { reject } of resolvers) reject(new Error(message));
      return;
    }
    for (const { resolve } of resolvers) resolve();
  }

  // Live-read on every gate check (driveLoop's own `get permissionMode()`), not resolved once —
  // the other half of C-1's fix, and finding 6: reads `liveState.session` (this function's own
  // comment above), not the old effect-refreshed `liveSession`, so a mid-run /mode is guaranteed
  // to be visible on the very next gate check rather than only "usually, once the effect catches
  // up in time." `skipPermissions` still wins unconditionally, matching prepareSession's own
  // original derivation of `prepared.permissionMode`: a run-scoped
  // `--dangerously-skip-permissions` override is not something a mid-run /mode should be able to
  // undo.
  function getPermissionMode(): PermissionMode {
    return skipPermissions ? "auto" : liveState.session.permissionMode;
  }

  // `root` (this function's own top, above) is awaited before the promise executor (below),
  // not inside it, so it is fully available before any code that reads it (runTurn's catch,
  // quit()) can possibly run — those are only ever reached from a keypress or reducer effect,
  // neither of which can fire before this function's own top-level `await` has resolved and the
  // tree is actually mounted.
  let resolveRunTui!: (result: DriveLoopResult) => void;
  let rejectRunTui!: (err: Error) => void;
  const settled = new Promise<DriveLoopResult>((resolve, reject) => {
    resolveRunTui = resolve;
    rejectRunTui = reject;
  });

  // Findings 1+5: the TUI's own ApprovalPrompt (loop.ts's contract, unchanged) — resolved via the
  // reducer's own pendingApproval state and a keypress (App.tsx's ApprovalBox) instead of
  // readline.question, so the TUI path never opens a second stdin consumer or a second SIGINT
  // route fighting Ink's own raw-mode ownership and signals.ts's single cancel slot. Only one
  // approval can ever be pending at a time (loop.ts awaits each one before its next gate check,
  // and `turnInFlight` already keeps at most one turn running), so a single closure variable is
  // enough to stash the resolver — the same pattern `resolveRunTui`/`currentTurn` above already
  // use. Wraps `resolve` (not stored bare) so the normal, keypress-driven resolution path also
  // disposes the `onAbort` registration below, mirroring makeApprovalPrompt's own
  // `abort.dispose()` in its `rl.on("close", ...)` handler — otherwise a stale listener would sit
  // on the turn's own AbortController for the rest of the turn, ready to double-resolve (harmless
  // but untidy: a Promise settles once, so this would just be a silent no-op) the next time it
  // aborts for an unrelated reason.
  let pendingApprovalResolve: ((answer: ApprovalAnswer) => void) | undefined;

  function tuiApprovalPrompt(
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ApprovalAnswer> {
    return new Promise<ApprovalAnswer>((resolve) => {
      // Mirrors makeApprovalPrompt's own already-aborted check: a turn already cancelled before
      // this call must not prompt at all.
      if (signal?.aborted === true) {
        resolve("no");
        return;
      }
      const offersAlways = PERSISTABLE_TOOLS.has(toolName);
      // The other direction, mirroring makeApprovalPrompt's own onAbort wiring: a cancel that
      // arrives WHILE this prompt is up (a Ctrl-C mid-approval) resolves "no" and clears
      // pendingApproval, the same as an explicit "n" answer would, instead of leaving the box
      // rendered with nothing left listening for an answer.
      const abort = onAbort(signal, () => {
        pendingApprovalResolve = undefined;
        dispatch({ type: "approval-resolved" });
        resolve("no");
      });
      pendingApprovalResolve = (answer) => {
        abort.dispose();
        resolve(answer);
      };
      dispatch({ type: "approval-requested", toolName, args, offersAlways });
    });
  }

  // The other end of tuiApprovalPrompt — App.tsx's onApprovalAnswer prop, called from
  // ApprovalBox's own keypress handler.
  function onApprovalAnswer(answer: ApprovalAnswer): void {
    const resolve = pendingApprovalResolve;
    if (resolve === undefined) return;
    pendingApprovalResolve = undefined;
    dispatch({ type: "approval-resolved" });
    resolve(answer);
  }

  // ModelPicker's own two resolutions (App.tsx's onModelSelected/onModelPickerCancel props) — both
  // dispatch model-picker-resolved, the one action that clears the picker and (only when a model
  // was actually picked) merges the pick into `state.session` in the same atomic transition
  // (reducer.ts's own comment on why that is one dispatch, not two). This is deliberately the ONLY
  // effect of a pick: `state.session.model`/`.provider` changes immediately, so the very next
  // runTurn call (which reads them fresh — that function's own comment) attempts the new model —
  // but `confirmedModel` (below) does NOT move here, so onSessionChange keeps writing the OLD,
  // still-working model/provider to disk until a turn actually succeeds on the new one.
  function onModelSelected(
    pick: { model: string; provider: ModelProvider; keyConfigured: boolean },
    leftoverInput?: string,
  ): void {
    dispatch({ type: "model-picker-resolved", pick, leftoverInput });
  }

  function onModelPickerCancel(): void {
    dispatch({ type: "model-picker-resolved" });
  }

  // Shift+Tab's own resolution (App.tsx's own comment on `onCycleMode` explains why this is a
  // prop, not a dispatch app.tsx makes itself): the same `decideModeCycle` /mode already calls
  // (`cycleModeCommand`, above), read off `liveState.session` — this closure's own synchronous
  // mirror of the reducer's state, not a stale copy — so `getPermissionMode()`'s own `liveState`
  // read is guaranteed to see the new mode on the very next gate check. Goes through
  // `sessionUpdated`, not a raw dispatch, for the same reason `cycleModeCommand` does — it is the
  // one thing this file documents as "the only thing that dispatches session-updated at all" on
  // the TUI path (this function's own header comment above). No `.message` call: Shift+Tab is
  // silent, unlike `/mode`, which prints its own transcript line.
  // `.catch`, not bare `void`: a `sessionUpdated` rejection (e.g. a save failure — this file's own
  // comment on `onSessionChange` above) is otherwise an unhandled rejection, and
  // `runtime/renderer.ts`'s `process.on("unhandledRejection", ...)` handler calls `process.exit(1)`
  // — this keypress isn't routed through the try/catch around `command.run` further below that
  // turns the identical failure into a `command-error` dispatch for `/mode`, so it needs its own.
  function onCycleMode(): void {
    const { next } = decideModeCycle(liveState.session);
    tuiPresenter(dispatch, awaitNextPersist, () => liveState.session)
      .sessionUpdated(next)
      .catch((err: unknown) => dispatch({ type: "command-error", message: messageOf(err) }));
  }

  const { onSetupSelect, onSetupKeyEntered, onSetupRemove, onSetupBack } = createSetupHandlers({
    dispatch,
    getPendingSetup: () => liveState.pendingSetup,
    configDir,
  });

  function onSetupClose(leftoverInput?: string): void {
    dispatch({ type: "setup-resolved", leftoverInput });
  }

  const { onLogin, onLogout, onAbandon } = createAuthHandlers({ dispatch, deps, configDir });

  const { onConfigSelect, onConfigValueEntered, onConfigUnset, onConfigBack } =
    createConfigHandlers({
      dispatch,
      getPendingConfig: () => liveState.pendingConfig,
      configDir,
    });

  function onConfigClose(leftoverInput?: string): void {
    dispatch({ type: "config-resolved", leftoverInput });
  }

  const { onPermissionsRemove, onPermissionsBack } = createPermissionsHandlers({
    dispatch,
    getPendingPermissions: () => liveState.pendingPermissions,
    permissionsDir: ctx.permissionsDir,
    getWorktree: () => checkpointTarget(liveState.session, dirs(ctx)).worktree,
  });

  function onPermissionsClose(leftoverInput?: string): void {
    dispatch({ type: "permissions-resolved", leftoverInput });
  }

  // EffortPanel's own two resolutions — extracted to createEffortHandlers, mirroring
  // createSetupHandlers'/createConfigHandlers' own factory shape. `effort-resolved` is the one
  // action that both clears `pendingEffort` and (only
  // when a tier was actually picked) merges it into `state.session`, in the same atomic transition
  // (reducer.ts's own comment on why). This is deliberately the ONLY effect of a pick, same as a
  // /model pick: `session.reasoningEffort` changes immediately, so the very next runTurn call
  // (which reads `session` fresh) sends it — the persist-on-success gate (below, runTurn's own
  // `messages-updated` handler) only overwrites the config default once a turn actually succeeds
  // on this tier, the same gate `confirmedModel` already has.
  const { onEffortSelected, onEffortCancel } = createEffortHandlers({ dispatch });

  // Runs one turn against whatever `session` is (the initial task on first call; the live
  // session plus a newly-submitted task on every later one — H-3), using the same dispatch the
  // reducer and driveLoop have always shared. Guarded against overlap: a second Enter press
  // while a turn is still running must not start a competing driveLoop call, which would fight
  // the first over signals.ts's single cancel slot. MEDIUM-1: the TUI path passes a no-op
  // `persist` — the reducer (via onSessionChange above) is the only writer now.
  // `inputText`, when given, is the current turn's OWN newly-submitted user message — not the full
  // prompt/system/history — used only to seed `turn-started`'s live input-token estimate (its own
  // comment, reducer.ts). `undefined` for a turn with no new typed text this call (the mount-time
  // "resume" path, runTui's own `connectDispatch`, continues a conversation already ending on an
  // unanswered user turn already in `session.messages` — not new this run).
  async function runTurn(session: SessionState<ModelMessage>, inputText?: string): Promise<void> {
    if (reactDispatch === undefined || turnInFlight) return;
    turnInFlight = true;
    ranAnyTurn = true;
    // Re-resolved from the CURRENT session on every turn — the actual /model fix. Before this,
    // every turn reused `prepared.model`, the LanguageModel prepareSession built once from
    // whatever session.model/provider were at the very start of the run, so a live switch
    // (ModelPicker's own onModelSelected, dispatched into the reducer) never took effect: the next
    // turn kept calling the old provider's endpoint no matter what the session said. `session` is
    // untouched here — this only changes which model answers it, not what it contains.
    //
    // Every session reaching here started as a RunSession (loadOrCreateSession's own backfill
    // guarantee) and stays one: every step along the way (decideModeCycle, decideRewind, the
    // reducer's own model-picker-resolved merge) only ever spreads the session it had, never drops
    // `model`/`provider`. TypeScript loses that once a session narrows to the reducer's own
    // `SessionState<ModelMessage>` (tui/reducer.ts), so this is the one place that puts it back —
    // the same kind of "this file already knows a stronger invariant tsc can't see" gap
    // `resolveRunTui!`'s own definite-assignment assertion, above, papers over too.
    // `requestedProvider` (RunSession's own, possibly-undefined `provider` field) is kept as its
    // own binding, not folded into `resolveSessionRoute` below's internal computation: rerouteNotice/
    // gatewayNotice (below) need the RAW, undefined-preserving value, not any DEFAULT_PROVIDER-
    // defaulted one — see their own call site's comment. `requestedModel` needed no equivalent
    // binding — nothing else in this function reads it once route resolution owns it.
    const { id: sessionId, provider: requestedProvider } = session as RunSession;
    // D3 (feature-plan.md): re-resolved every turn, same reasoning as the model re-resolution
    // above — a routing-priority reroute (D2) must be reconsidered on every turn too, not just at
    // session start, so a key added mid-session via /setup takes effect on the very next turn.
    //
    // Bug fixed here (code-review, PR #73): `resolveRoute`/`configuredProviders` used to run
    // OUTSIDE this try — `configuredProviders` reads config.json via a bare `JSON.parse`, so a
    // corrupted file threw SYNCHRONOUSLY. `runTurn` is called fire-and-forget
    // (`currentTurn = runTurn(...)`, no `.catch()` at either call site), so that throw became an
    // unhandled rejection — a config.json corrupted mid-session (a concurrent /setup write from
    // another instance, say) crashed the running TUI on the very next turn, losing in-progress
    // work. Inside the try, it degrades the same way a getModel failure already does: a
    // command-error the user can see and recover from, not a crash.
    // `ResolvedRoute` directly, not `ReturnType<typeof resolveRoute>`: the
    // `resolveRoute` VALUE was never called from this scope (only `resolveSessionRoute`, just
    // below), so it was imported as a type-only binding purely to spell this declaration — dropped
    // now that the type it names is already imported under its own name.
    let route: ResolvedRoute;
    let model: LanguageModel;
    let config: Record<string, string>;
    try {
      route = resolveSessionRoute(
        session,
        prepared.catalog,
        configuredProviders(configDir),
        prepared.plan,
        configDir,
      );
      model = dispatchModel(route, sessionId, configDir, deps);
      // Read inside the same try as route/model resolution, not after it: `configuredProviders`
      // above already reads config.json via `loadConfig`, so config.json can be rewritten
      // concurrently between that read and this one (another `seri` process, a hand edit) — and
      // this function is called fire-and-forget (no `.catch()` at either call site), so a throw
      // reaching past this try would become an unhandled rejection instead of the command-error
      // the catch below degrades every other failure in this block to.
      config = loadConfig(configDir);
    } catch (err) {
      // tuiMissingKeyMessage, not a bare err.message: this catch is reachable ONLY from inside an
      // already-running TUI turn (runTurn, called solely by runTui), where /setup is a keystroke
      // away — unlike prepareSession's own earlier catch (this function, above) and the
      // non-interactive path, neither of which can assume a TUI is even mounted.
      dispatch({
        type: "command-error",
        message: tuiMissingKeyMessage(err),
      });
      turnInFlight = false;
      return;
    }
    const { model: modelId, provider } = route;
    // Issue #132 fix: the status bar reads `state.route` (reducer), not a prop frozen at mount —
    // dispatching the freshly resolved route here, every turn, is what makes a /model switch (or
    // any other mid-session reroute) show up without waiting for the session to quit and remount.
    dispatch({ type: "route-updated", route });
    // See "config-updated"'s own comment (reducer.ts) for why this is re-dispatched every turn
    // alongside `route-updated`.
    dispatch({ type: "config-updated", config });
    // Starts TurnStatus's elapsed clock/token count — dispatched here, alongside `route-updated`,
    // rather than earlier: this is the first point in runTurn a turn is actually committed to
    // running (resolveRoute/dispatchModel have already succeeded above), not just requested.
    // `inputEstimate` is 0 when `inputText` is undefined (this function's own comment) — the "no
    // live signal available" convention this feature already uses for a partial usage record
    // applies here too, rather than guessing or double-counting old messages.
    dispatch({
      type: "turn-started",
      startedAt: Date.now(),
      inputEstimate: inputText === undefined ? 0 : estimateTokens(inputText),
    });
    // A rerouted OR gateway-served pair is never silent on the TUI path either — see
    // prepareSession's own identical notice for the piped/non-interactive path, above.
    if (route.rerouted) {
      dispatch({
        type: "transcript-append",
        line: `↻ ${rerouteNotice(route, requestedProvider)}`,
      });
    } else if (route.viaGateway) {
      dispatch({
        type: "transcript-append",
        line: `↻ ${gatewayNotice(route, requestedProvider)}`,
      });
    }
    // D3's own consequence: findCatalogEntry on the RESOLVED pair, not the requested one.
    const catalogEntry = findCatalogEntry(prepared.catalog, modelId, provider);
    // A reroute is never silent (just above) — neither is a session
    // `reasoningEffort` override that is about to be silently dropped this turn because it isn't
    // legal for the RESOLVED route. `appliedReasoningEffort` (provider/reasoning.ts) is the exact
    // same legality check loop.ts's own re-validation gate applies before sending, so "undefined
    // here" means "would also be dropped there" — reusing the same transcript channel the
    // reroute/gateway notices above use.
    if (
      session.reasoningEffort !== undefined &&
      appliedReasoningEffort(session.reasoningEffort, catalogEntry) === undefined
    ) {
      dispatch({
        type: "transcript-append",
        line: `↻ reasoning effort "${session.reasoningEffort}" isn't legal for the current model — this turn runs without it.`,
      });
    }
    // `session as RunSession`, not the raw (reducer-typed) `session`: PreparedRun.session is now
    // RunSession (code-review finding — see PreparedRun's own comment), and this call site already
    // established the same invariant two lines up for `requestedModel`/`requestedProvider`; reusing
    // it here instead of casting a second time in one function.
    const turnPrepared: PreparedRun = {
      ...prepared,
      session: session as RunSession,
      model,
      catalogEntry,
      route,
    };
    // Reset once per call to runTurn — i.e. once per turn, not once per `messages-updated` event
    // (code-review finding on PR #71's own re-review). `modelId`/`provider` are resolved once,
    // above (`route`), and never change for the life of one driveLoop call, so a boolean is all
    // that's needed: loop.ts can yield `messages-updated` several times in a single turn (once per tool
    // call), and without this, a PERSISTENTLY failing write (a config dir that stays read-only for
    // the whole turn, not a one-off transient blip) would retry — and re-warn — on every one of
    // those events instead of once. `lastPersistedModel`'s own retry-on-a-LATER-turn guarantee is
    // untouched: this only caps attempts to at most one per turn, it does not suppress the next
    // turn's own attempt.
    let persistAttemptedThisTurn = false;
    // Same one-attempt-per-turn cap as persistAttemptedThisTurn above, independent of it: the
    // model pair and the reasoning-effort override are two different config.json keys, and a
    // turn that persists one must not be blocked from also persisting the other.
    let reasoningEffortPersistAttemptedThisTurn = false;
    // Boxed rather than a bare `unknown`: a rejection whose value is itself `undefined` (e.g. a
    // bare `Promise.reject()`) must still be distinguishable from "no error happened" below, or
    // the `!== undefined` check silently treats it as success and leaves H-2's own hang reopened.
    let failure: { err: unknown } | undefined;
    try {
      const result = await driveLoop(
        turnPrepared,
        ctx,
        deps,
        liveMaxTurns,
        (event) => {
          dispatch({ type: "loop-event", event });
          // B2 fix: `messages-updated` is loop.ts's own signal that a model call actually
          // succeeded (loadOrCreateSession's own comment: "driveLoop's messages-updated save
          // records it... only after a turn the provider actually answered") — so THIS turn's
          // `modelId`/`provider` (destructured above, what it was actually called with) are now
          // demonstrably working and safe to persist. Confirming on every turn, not just a
          // picker-driven one, is a no-op for the common case (same value already) and is what
          // makes a picker switch's FIRST successful turn confirm it, with no special-casing for
          // "was this turn a switch."
          //
          // Two independent inequality guards below, against two independent variables
          // (`confirmedModel`'s own comment explains why they're no longer one) — each is still a
          // three-job guard on its own: (1) turn-switch detection for its own variable; (2)
          // `messages-updated` fires several times per turn (loop.ts's own multiple yield sites),
          // so an unguarded check would be one action per tool call; (3) it is what keeps a user
          // who never picks anything from ever getting DEFAULT_MODEL frozen into config.json,
          // pinning them to today's default across a binary upgrade — both variables start at the
          // session's own starting pair, so turn 1 (same model) trips neither.
          if (event.type === "messages-updated") {
            if (modelPairChanged(confirmedModel, { model: modelId, provider })) {
              confirmedModel = { model: modelId, provider };
            }
            // Gated on `lastPersistedModel`, not `confirmedModel`: the try/catch + printWarning
            // mirrors onSessionChange's own pattern above — a config write failure (EACCES,
            // ENOSPC, a read-only config dir) must degrade to a warning, never convert a turn
            // that already succeeded into a failure — but unlike `confirmedModel`, this variable
            // only advances on a SUCCESSFUL persist, so a failed attempt is retried by the next
            // turn that lands on this same model/provider, instead of being silently and
            // permanently skipped for the rest of the session. `persistAttemptedThisTurn` (its own
            // comment, above) is what caps that retry at one ATTEMPT per turn — without it, a
            // persistently failing write (as opposed to the one-off transient blip the retry above
            // is for) would re-attempt, and re-warn, on every `messages-updated` a multi-tool-call
            // turn yields, reintroducing the exact per-tool-call write-amplification the ORIGINAL
            // (pre-B2-fix, single-variable) inequality guard's comment (2) already promised to
            // prevent.
            if (
              !persistAttemptedThisTurn &&
              modelPairChanged(lastPersistedModel, { model: modelId, provider })
            ) {
              persistAttemptedThisTurn = true;
              try {
                persistDefaultModel({ model: modelId, provider }, configDir);
                lastPersistedModel = { model: modelId, provider };
              } catch (err) {
                const message = messageOf(err);
                printWarning(`could not save the default model: ${message}`);
              }
            }
            // /effort's own persist-on-success check, same trigger as confirmedModel/
            // lastPersistedModel just above: `session` (runTurn's own parameter, captured by this
            // closure) is what THIS turn actually ran with, so a successful messages-updated is
            // exactly the signal to check whether this reasoning-effort override is safe to persist
            // as the new config.json default. `appliedReasoningEffort`, not the raw
            // `session.reasoningEffort`: the tier sitting in session state
            // can be stale for the CURRENTLY resolved `catalogEntry` — e.g. `/effort xhigh` was set
            // on a route where it was legal, then `/model` switched to one where it isn't —
            // loop.ts's own re-validation gate already silently drops a tier like that rather
            // than sending it, and persisting it anyway here would keep writing a value that just
            // keeps getting silently dropped, every future session inheriting the same dead
            // default. `appliedReasoningEffort` is the one shared function both gates call, so they
            // can never disagree about what "legal for this turn" means. `undefined` (no override,
            // /effort auto, or a now-illegal tier) never persists — there is nothing safe to write,
            // and clearing a session override must not also clear the config default it falls back
            // to.
            const appliedTier = appliedReasoningEffort(session.reasoningEffort, catalogEntry);
            // Compared against config.json's own CURRENT value, read fresh here rather than a
            // cached variable — see this closure's own declaration site (above) for why: /config
            // can rewrite SERI_REASONING_EFFORT directly, mid-session, and a cached comparison
            // value has no way to see that write happen.
            const currentConfig = loadConfig(configDir);
            if (
              !reasoningEffortPersistAttemptedThisTurn &&
              appliedTier !== undefined &&
              appliedTier !== loadReasoningEffortConfig(currentConfig)
            ) {
              reasoningEffortPersistAttemptedThisTurn = true;
              try {
                persistDefaultReasoningEffort(appliedTier, configDir);
                // Constructed in memory (persistDefaultReasoningEffort's own contract, config.ts:
                // `setConfigValue("SERI_REASONING_EFFORT", tier, configDir)`, is exactly this merge),
                // not re-read from disk: this write is invisible to the header otherwise (it lands
                // between turns, not from /config or the next turn's own re-read), so it needs the
                // same "config.json just changed" dispatch those already send — but a second disk
                // read here could throw on an unrelated race and misreport this successful write as
                // a failure (code-review finding), for a value already known without it.
                dispatch({
                  type: "config-updated",
                  config: { ...currentConfig, SERI_REASONING_EFFORT: appliedTier },
                });
              } catch (err) {
                const message = messageOf(err);
                printWarning(`could not save the default reasoning effort: ${message}`);
              }
            }
          }
        },
        getPermissionMode,
        () => {},
        tuiApprovalPrompt,
        archivistState,
        (payload) => dispatch({ type: "subagent-child-event", ...payload }),
      );
      usage = {
        inputTokens: addTokens(usage.inputTokens, result.usage.inputTokens),
        outputTokens: addTokens(usage.outputTokens, result.usage.outputTokens),
      };
      cost = addCost(cost, result.cost);
      doneReason = result.doneReason;
      refusedWithoutRunning = result.refusedWithoutRunning;
      archivist = result.archivist;
      // Rendered live into the transcript the moment it happens, the same run this turn just
      // produced it in — not deferred to session end, unlike the `archivist` copy above, which only
      // feeds the FINAL resolveRunTui result (printed once more after Ink unmounts, quit()'s own
      // comment explains why). Stats are a muted plain line so the markdown parser never sees
      // "(archivist: …)"; a defined summary is a second muted markdown entry.
      if (result.archivist) {
        pushTranscriptLine(dispatch, archivistStatsLine(result.archivist), { muted: true });
        if (result.archivist.summary !== undefined) {
          pushTranscriptLine(dispatch, result.archivist.summary, { muted: true, markdown: true });
        }
      }
      // LOW-J: `result.cancelledBy` is deliberately not read here. The TUI never re-raises a
      // signal on a plain, individually-cancelled turn (H-3 returns it to awaiting input, not to
      // process death) — only quit()'s own resolve decides `cancelledBy` for the run as a whole,
      // and it always passes `undefined`, since even a turn quit() itself cancelled first
      // (HIGH-B) ends the *session* by choice, not by a signal the shell needs to see re-raised.
    } catch (err) {
      failure = { err };
    } finally {
      turnInFlight = false;
      // The one place `driveLoop`'s own call is known to have genuinely settled, success or
      // failure — mirrors `turn-started`'s own dispatch above, at the one place a turn is known to
      // have genuinely begun. This `finally` always runs before the `destroyTuiRenderer()` call
      // below (a `finally` block executes before any code following the `try` statement), so a
      // failed turn's dispatch still reaches a renderer that is genuinely still mounted — a
      // dispatch issued only after `destroyTuiRenderer()` would have no host left to schedule a
      // React update on.
      dispatch({ type: "turn-ended" });
    }
    if (failure !== undefined) {
      // H-2: driveLoop rejecting (not just resolving with an aborted/errored `done`) used to
      // leave this promise — and run()'s own `await runTui(...)` — hanging forever. Destroy the
      // renderer first so raw mode is restored (M-2's own mechanism, mirrored here rather than
      // relying solely on the fatal-signal cleanup below, since a rejection is not a signal), then
      // reject, so run() actually settles instead of hanging.
      destroyTuiRenderer();
      rejectRunTui(failure.err instanceof Error ? failure.err : new Error(String(failure.err)));
    }
  }

  // HIGH-1: the ONLY way this function's outer promise ever resolves (as opposed to rejecting, or
  // the process dying by signal on the fatal Ctrl-C path — see runtime/renderer.ts). Before this
  // existed, runTui's promise only ever rejected, so run()'s printUsage/raiseSignal/exit-code
  // logic was unreachable dead code for the entire TUI path, even after a turn completed
  // normally.
  //
  // HIGH-B: if a turn is still running, quit() used to abandon it outright — controller.abort()
  // was never called (so a tool child process kept running after this process was gone),
  // whatever usage the abandoned turn had already spent was never folded into `usage` below, and
  // `turnInFlight` never cleared, so runTui's promise never resolved at all and run() hung
  // forever. Cancelling first, via the exact same deliverSignal("SIGINT") path a single Ctrl-C
  // already uses, makes the turn unwind the normal way — driveLoop yields whatever final
  // messages-updated/usage it can on the way out, runTurn's own try folds that into `usage` and
  // `doneReason` (below, unchanged), and only once `currentTurn` actually settles does this
  // proceed to the real quit sequence. `doneReason` for a turn ended this way is "aborted", which
  // (run()'s own exit-code comment, further down, has the full accounting) resolves to exit 1 —
  // the same code every other *unaccomplished* run returns (`max-iterations`,
  // `repeated-denials`), not the signal-death every OTHER abort path in this file uses: a
  // deliberate quit is not the fatal-signal case `raiseSignal` exists for. A task that was cut
  // off mid-run is still not one `seri "…" && next` should treat as accomplished just because
  // the user, not the model, was the one who ended it — this all assumes the cancel slot is
  // still free. If a Ctrl-C already spent it (signals.ts's single slot, cleared the instant a
  // press is delivered, before the turn it cancelled has even finished unwinding), the
  // deliverSignal("SIGINT") call below still runs, but finds nothing registered and falls
  // through to signals.ts's own fatal path instead — no unwind, no summary, the process dies by
  // signal, the same as a second bare Ctrl-C press (AGENTS.md's own paragraph on the TUI covers
  // this).
  async function quit(): Promise<void> {
    if (reactDispatch === undefined || quitting) return;
    quitting = true;
    // Without this, Ctrl-D would be silently swallowed while ApprovalBox is mounted instead of
    // InputBox. Denying the pending approval is folded into the SAME graceful
    // quit sequence — not a separate "deny just this one prompt" path the way the old
    // readline-based prompt's own Ctrl-D-at-empty-line handling worked — so Ctrl-D keeps one
    // consistent meaning everywhere in the TUI. The turn this unblocks is still in flight
    // afterward (a denied approval is not a finished turn), so the turnInFlight branch below
    // still runs exactly as it would for any other in-flight-turn quit.
    if (liveState.pendingApproval !== undefined) onApprovalAnswer("no");
    // No final re-render before this, unlike the Ink original: that rerender's only purpose was
    // flipping a `done` prop to true so App's own effect called `useApp().exit()` — app.tsx has no
    // such effect at all (this function owns the renderer's lifecycle directly), so there is
    // nothing left for a final render to trigger. `destroyTuiRenderer()` is synchronous
    // (`CliRenderer.destroy(): void`, unlike Ink's
    // async `waitUntilExit()`), so `resolveRunTui` follows it directly, no `.then`/`.catch` needed.
    const finishQuit = (): void => {
      destroyTuiRenderer();
      resolveRunTui({
        doneReason,
        cancelledBy: undefined,
        usage,
        cost,
        refusedWithoutRunning,
        archivist,
        ranAnyTurn,
      });
    };
    if (turnInFlight) {
      // MEDIUM-5: without this, cancelling a still-running turn on the way out (this whole
      // branch's own comment above) left the TUI looking frozen for however long the turn took
      // to unwind, with no indication anything had happened or that Ctrl-C was still available
      // to force it — dispatched before deliverSignal so it is visible even if the unwind never
      // completes (a stuck tool ignoring its own abort signal). `flushSync` + `renderer.idle()`
      // are both required, not just one: the abort→turn-settles→finishQuit chain below runs
      // entirely on microtasks (the fake runLoop test's own abort listener resolves synchronously
      // once SIGINT is delivered), while `@opentui/react`'s reconciler otherwise commits on a
      // macrotask — without forcing the commit and waiting for the actual paint, `finishQuit`'s
      // `destroyTuiRenderer()` tore down the alt-screen before this line was ever painted (found
      // live: it never once appeared in a captured pty session).
      flushSync(() =>
        pushTranscriptLine(dispatch, "quitting — cancelling the in-flight turn, Ctrl-C to force"),
      );
      await renderer.idle();
      deliverSignal("SIGINT");
      void currentTurn.then(finishQuit);
    } else {
      finishQuit();
    }
  }

  // Claimed TUI names (and /effort, which is session but tuiClaimsFirst) run from this Record
  // before the SLASH_COMMANDS / turnInFlight gate. Panel commands stay legal mid-turn. Missing a
  // catalog name here is a load-time throw, not a silent fallthrough into effortCommand or a task.
  type TuiHandler = (args: string[]) => void | Promise<void>;
  const tuiHandlers: Record<string, TuiHandler> = {
    "/exit": async () => {
      await quit();
    },
    "/model": () => {
      // configuredProviders reads config.json via a bare JSON.parse — a corrupted file throws
      // synchronously, and onSubmit has no caller-side .catch() (InputBox calls it fire-and-forget),
      // so this must be a visible command-error the same way every other failure here degrades.
      try {
        dispatch({
          type: "model-picker-requested",
          // configuredProviders is re-read fresh on every open, not cached from prepareSession — a
          // key added mid-session via /setup must show up in the very next /model open. `plan` is
          // NOT re-fetched here: prepareSession's own value, carried on `prepared` for the life of
          // the run.
          entries: decideModelPickerOpen(
            prepared.catalog,
            configuredProviders(configDir),
            // gatewayCoverageInGroup, not a bare planCoverage(entry, plan): the picker's own
            // coverage must agree with resolveRoute's (routing.ts's own comment on why they share
            // one function) — a row's OWN entry can be priced/planned differently than its
            // OpenRouter-catalog sibling, which is the only thing the gateway actually forwards to.
            // The group variant, not gatewayCoverage itself: decideModelPickerOpen already grouped
            // the whole catalog once and hands back each entry's own group here, so this avoids
            // re-deriving it via routesFor's own scan on every one of the ~350 rows it emits.
            (entry, group) => gatewayCoverageInGroup(group, prepared.plan) !== undefined,
          ),
        });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    // Claim every form (bare, `<level>`, `auto`). Fallthrough to SLASH_COMMANDS would hit
    // effortCommand, which awaits two network calls before sessionUpdated() — a window where an
    // in-flight turn's session-updated (a full replace, not a merge) can be discarded by
    // effortCommand's later one. prepared.catalog / prepared.plan are already resolved, so
    // applyEffortCommand is synchronous between reading liveState.session and dispatching.
    "/effort": async (args) => {
      try {
        if (args.length === 0) {
          const opened = decideEffortOpen(
            prepared.catalog,
            configDir,
            liveState.session,
            prepared.plan,
          );
          if (opened === null) {
            dispatch({
              type: "command-error",
              message: "This model has no reasoning-effort tiers available.",
            });
            return;
          }
          dispatch({ type: "effort-requested", tiers: opened.tiers, selected: opened.selected });
          return;
        }
        await applyEffortCommand(
          liveState.session,
          args,
          prepared.catalog,
          prepared.plan,
          configDir,
          tuiPresenter(dispatch, awaitNextPersist, () => liveState.session),
        );
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/setup": () => {
      try {
        dispatch({ type: "setup-requested", rows: decideSetupOpen(configDir) });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/login": async () => {
      await onLogin("login");
      // onLogin resolves the same way on success and failure (its try/catch degrades to a rendered
      // auth-step, never a rejection), so this always re-fetches — a failed/abandoned attempt still
      // finds nothing and fetchAccountPlan short-circuits to null; on success this is what makes a
      // freshly-logged-in plan visible to resolveRoute / /model without waiting for a restart.
      prepared.plan = await fetchAccountPlan(configDir);
    },
    "/signup": async () => {
      await onLogin("signup");
      prepared.plan = await fetchAccountPlan(configDir);
    },
    "/logout": async () => {
      await onLogout();
      // Cleared directly rather than re-fetched: fetchAccountPlan would return null here anyway
      // (its login guard sees no session once logout succeeds), and if logout itself somehow
      // failed, null is still the fail-closed answer PreparedRun.plan already commits to — never
      // let a stale paid plan keep resolveRoute / /model showing "provided" after the user asked
      // to log out.
      prepared.plan = null;
    },
    "/config": () => {
      try {
        dispatch({ type: "config-requested", rows: decideConfigOpen(configDir) });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/permissions": () => {
      // decidePermissionsOpen's loadGrants never throws for a malformed store — it degrades to an
      // empty list and reports through onWarning. Dropping that callback opened a silently-empty
      // panel. ctx.permissionsDir, not configDir — see createPermissionsHandlers (tui/handlers.ts).
      try {
        dispatch({
          type: "permissions-requested",
          rows: decidePermissionsOpen(
            ctx.permissionsDir,
            checkpointTarget(liveState.session, dirs(ctx)).worktree,
            (message) => dispatch({ type: "command-error", message }),
          ),
        });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    // One-shot, no panel: confirm via transcript-append, fail via command-error.
    "/max-turns": (args) => {
      try {
        liveMaxTurns = decideMaxTurns(args);
        dispatch({
          type: "transcript-append",
          line: `Max turns set to ${liveMaxTurns} — takes effect on the next turn.`,
        });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
    "/profile": (args) => {
      try {
        const { dir, name: profileName } = decideProfileCreate(args);
        // This directory will hold auth.json/config.json/permissions.yaml once the profile is
        // used, so it is owner-only like every other secrets-holding directory this codebase
        // creates (ensureOwnerOnlyDir, atomicWriteFile.ts). `created` comes from the mkdir call
        // itself rather than a separate existsSync(dir) probe beforehand — a probe-then-create
        // pair races two concurrent `/profile new work` invocations into both observing "doesn't
        // exist yet" and both claiming "created" for a directory only one of them actually made.
        const created = ensureOwnerOnlyDir(dir);
        dispatch({
          type: "transcript-append",
          // `profileName`, not basename(dir): decideProfileCreate already validated it, and for
          // a name whose resolved `dir` has no trailing segment equal to it, basename(dir) would
          // be wrong (decideProfileCreate's own comment explains when that happens).
          line: `Profile directory ${dir} ${created ? "created" : "already exists"}. This does not switch the running session's profile — restart with --profile ${profileName} or SERI_PROFILE to use it.`,
        });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: messageOf(err),
        });
      }
    },
  };
  assertTuiHandlers(tuiHandlers);

  async function onSubmit(value: string): Promise<void> {
    if (reactDispatch === undefined) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    // Deliberately unconditional and before every branch below (not per-branch, and not moved
    // below the /exit/unrecognized-command guards): a rejected submission — invalid args, an
    // unrecognized command, /exit with arguments — still gets its typed text echoed here, so the
    // command-error it produces has an antecedent that scrolls with it instead of a floating
    // error with nothing to explain it. Do not sink this below the guards.
    echoUserInput(value);
    const [name = "", ...args] = trimmed.split(/\s+/).filter(Boolean);
    const spec = commandByName(name);
    if (spec !== undefined && isTuiClaimed(spec)) {
      if (!spec.accepts(args)) {
        dispatch({ type: "command-error", message: `${name}: invalid arguments.` });
        return;
      }
      const handler = tuiHandlers[name];
      if (handler === undefined) {
        throw new Error(`tuiHandlers missing ${name}`);
      }
      await handler(args);
      return;
    }
    const command = SLASH_COMMANDS.get(name);
    if (command === undefined) {
      if (name.startsWith("/")) {
        dispatch({ type: "command-error", message: `Unrecognized command: ${name}` });
        return;
      }
      if (turnInFlight) {
        dispatch({
          type: "command-error",
          message: "A turn is already running; wait for it to finish before submitting another.",
        });
        return;
      }
      currentTurn = runTurn(
        {
          ...liveState.session,
          messages: [...liveState.session.messages, { role: "user", content: trimmed }],
        },
        trimmed,
      );
      return;
    }
    if (!command.accepts(args)) {
      dispatch({ type: "command-error", message: `${name}: invalid arguments.` });
      return;
    }
    if (turnInFlight && command.mutatesRunState === true) {
      dispatch({
        type: "command-error",
        message: `${name}: can't run while a turn is in flight.`,
      });
      return;
    }
    // A mutating command (e.g. /compact) can itself take a multi-second-to-multi-minute round
    // trip, and without this a task submitted during that window would start a real turn: it
    // would steal the single onSignalCancel slot the command holds, and the command's own
    // sessionUpdated would later overwrite that turn's session with its pre-command snapshot.
    // Setting the same flag runTurn sets makes the guards above (this one and the plain-task one)
    // correctly reject a submission for the duration of the command's own run.
    if (command.mutatesRunState === true) turnInFlight = true;
    // Captured before the try: the only thing that distinguishes "/clear ran" from "/mode or
    // /rewind ran" for the rebind below is that /clear mints a brand-new session id (decideClear's
    // own comment) while every other command's dispatch (this closure's own `dispatch`, synchronous
    // — the /rewind branch below already relies on this) preserves it. Keying the rebind on that
    // actual identity change, not on `name === "/clear"`, means a future command that also mints a
    // new session id is covered by construction instead of needing its own added branch here.
    const sessionIdBeforeCommand = liveState.session.id;
    // /compact's usage fold, shared by both command.run call sites just below.
    const foldUsage = (u: LanguageModelUsage): void => {
      usage = {
        inputTokens: addTokens(usage.inputTokens, u.inputTokens),
        outputTokens: addTokens(usage.outputTokens, u.outputTokens),
      };
    };
    try {
      if (command.needsSession === false) {
        await command.run(
          args,
          dirs(ctx, prepared.trajectory),
          tuiPresenter(dispatch, awaitNextPersist, () => liveState.session, foldUsage),
          deps,
        );
      } else {
        await command.run(
          liveState.session,
          args,
          dirs(ctx, prepared.trajectory),
          tuiPresenter(dispatch, awaitNextPersist, () => liveState.session, foldUsage),
          deps,
        );
      }
      // resetArchivistForRewind's own comment (memory/archivist.ts) explains why this must be
      // deterministic, at the truncation site, rather than left to maybeRunArchivist's generic
      // guard. `liveState.session` is already the post-rewind truncation by this point —
      // `dispatch` (this closure's own wrapper) updates it synchronously, before command.run even
      // returns.
      if (name === "/rewind") {
        resetArchivistForRewind(archivistState, liveState.session.messages);
      }
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
    } finally {
      if (command.mutatesRunState === true) turnInFlight = false;
      // Without this, `prepared.checkpointer`/`prepared.tools` — built once at session start,
      // closing over the OLD session's id — silently keep appending checkpoints to the OLD
      // session's git ref and log file (checkpoint.ts's own sessionRef/logPath, both keyed on
      // sessionId) for every tool call made after /clear: no error, no warning, just checkpoints
      // landing under a session nothing resumes anymore. In `finally`, keyed on the id actually
      // having changed rather than on `command.run` having resolved: `tuiPresenter`'s own
      // `sessionUpdated` (this file's own `CommandPresenter` comment) dispatches `session-updated`
      // synchronously, before its returned promise settles, so a persistence failure that later
      // rejects that promise still leaves `liveState.session` pointing at the new id — living in the
      // try block above (as this used to) meant that rejection skipped the rebind entirely, stranding
      // the checkpointer/tools on the abandoned session with no error surfaced for it.
      // `storeDir`/`worktree` are unchanged by /clear (decideClear carries `cwd` over verbatim, so
      // checkpointTarget would resolve to the identical pair) — reused directly from `prepared`
      // rather than recomputed. `createArchivistState`, not `resetArchivistForRewind`: the latter
      // deliberately leaves `toolCallsSinceRun` alone (correct for a truncation of the SAME
      // conversation), which would carry a stale tool-call count into a conversation that has none.
      // `prepared.session`/`prepared.memory` are reassigned alongside checkpointer/tools/
      // archivistState (bindSession, above) — every one of those fields is documented on
      // `PreparedRun` as resolved once per run, and this is the one place any of them would
      // otherwise keep pointing at the pre-/clear session for the rest of the process.
      //
      // `liveState.session as RunSession`: the same invariant runTurn's own destructuring already
      // relies on (its own comment) — decideClear only ever spreads an existing RunSession and
      // touches `id`/`messages`/`systemPrompt`, so the result still carries `model`/`provider`.
      //
      // In its own try/catch, not left to the outer one: `bindSession` calls
      // `buildCheckpointedTools`, which can throw the same way `prepareSession`'s identical call
      // does (a corrupted config.json read by `loadVerifyConfig`, on the startup path — reused
      // here via `prepared.verifyConfig`, not re-read, but `createCheckpointer` itself still spawns
      // git). Uncaught here, in `finally`, would leave the TUI as an unhandled rejection instead of
      // the command-error every other failure in this function already surfaces as — the same
      // reasoning the /undo-/restore `invalidate()` block just below this one already applies to
      // its own git call.
      if (liveState.session.id !== sessionIdBeforeCommand) {
        try {
          archivistState = bindSession(
            prepared,
            liveState.session as RunSession,
            configDir,
            printWarning,
          );
        } catch (err) {
          dispatch({
            type: "command-error",
            message: `session switched to ${liveState.session.id} but checkpointing could not be rebound; restart seri before making further edits: ${messageOf(err)}`,
          });
        }
      }
      // /undo and /restore just forced the worktree to a state this closure's live `checkpointer`
      // never saw happen — it is the SAME instance every ongoing tool call in this TUI session
      // checkpoints through, and its own `previousTree`/`previousCommit` are now stale: the next
      // non-destructive bash/powershell call would reuse `previousTree` (createCheckpointer's own
      // "gate first checkpoint of a process" comment explains why that reuse exists at all) as
      // though nothing had happened since it was recorded, when the restore just rewrote the
      // worktree out from under it. In `finally` rather than after the call: applyRestore's own
      // comment (shadowGit.ts) explains it checks out files before removing the post-snapshot ones,
      // so an EPERM/EBUSY thrown by the removal half on Windows still lands after the worktree was
      // already rewritten — the checkpointer must resync on that throwing path too, not only on
      // success. `invalidate()` clears the stale state so the very next mutating call takes a real
      // snapshot instead of trusting a tree the restore already invalidated.
      //
      // In its own try/catch: invalidate() spawns git (resolveRef), which can throw the same way
      // every other git spawn in this subsystem can (index.lock contention between two seri
      // processes, a full disk). onSubmit is called fire-and-forget from InputBox, so an
      // uncaught throw here would leave the TUI as an unhandled rejection instead of the
      // command-error the surrounding catch above already exists to report — and would silently
      // replace whatever error that catch just handled.
      if (name === "/undo" || name === "/restore") {
        try {
          prepared.checkpointer.invalidate();
        } catch (err) {
          dispatch({
            type: "command-error",
            message: `could not resync checkpointing after ${name}; the next mutating tool call will still take a fresh snapshot: ${messageOf(err)}`,
          });
        }
      }
    }
  }

  root.render(
    createElement(App, {
      session: prepared.session,
      route: prepared.route,
      catalog: prepared.catalog,
      config: initialConfig,
      onSubmit,
      onSessionChange,
      onQuit: quit,
      onApprovalAnswer,
      onModelSelected,
      onModelPickerCancel,
      onCycleMode,
      skipPermissions,
      onSetupSelect,
      onSetupKeyEntered,
      onSetupRemove,
      onSetupBack,
      onSetupClose,
      // /config and /permissions' own handlers — wired here, runTui's own mount, only (not
      // runGuidedSetup's, same reasoning as onLogin/onLogout/onAuthResolved's own comment below:
      // that mount always has `pendingSetup` set, so these panels are structurally unreachable
      // there).
      onConfigSelect,
      onConfigValueEntered,
      onConfigUnset,
      onConfigBack,
      onConfigClose,
      onPermissionsRemove,
      onPermissionsBack,
      onPermissionsClose,
      onEffortSelected,
      onEffortCancel,
      // No auth-offer recompute here — redundant: every path that reaches this (Escape on
      // "starting"/"device", Enter/Esc on a login-failure result, or
      // a logout-failure result) never changed the auth-session file between when it was last
      // read and this firing — a login failure means saveAuthSession never ran, and a logout
      // failure's own result panel already got a truthful recompute from onLogout's own single
      // post-try/catch dispatch (createAuthHandlers' own comment, tui/handlers.ts). `onAbandon`
      // still runs first: a still-in-flight login dismissed from "starting"/"device" must actually
      // cancel (real AbortController, not just a dispatch guard) before anything else here runs.
      onAuthResolved: () => {
        onAbandon();
        dispatch({ type: "auth-resolved" });
      },
      connectDispatch: (reducerDispatch: Dispatch) => {
        reactDispatch = reducerDispatch;
        // See PreparedRun.preMountMessages' own comment: prepareSession queued these instead of
        // printing them directly, since it runs after the shared renderer already exists but
        // before this mount.
        // `.stream` is ignored deliberately (PreMountMessage's own comment): every queued line
        // lands in the transcript either way, regardless of which console stream it would have
        // gone to on a non-TTY run.
        for (const { text } of prepared.preMountMessages) {
          dispatch({ type: "transcript-append", line: text });
        }
        // The non-blocking login/signup offer (AuthBanner) — true iff no auth session is
        // saved yet, computed fresh at mount the same way decideSetupOpen/decideModelPickerOpen are
        // computed fresh on their own open, not cached from prepareSession.
        dispatch({ type: "auth-offer", show: decideAuthOffer(configDir) });
        // runStart — the same three-state predicate prepareSession (above) uses to decide whether
        // it pushed the initial user message at all: "task" echoes and starts a turn on it,
        // "resume" (a bare `--continue`/`--resume`) starts a turn only if the resumed session
        // still awaitsReply (session/awaitsReply.ts), and "idle" (bare `seri`, no resume, no task)
        // starts nothing. TUI-mount-only: the non-interactive branch below (`isTTY` false) still
        // starts a turn unconditionally on "resume" — a known, narrower scope for this gate, not
        // an oversight; see that branch's own comment.
        const start = runStart(ctx);
        if (start === "task") echoUserInput(ctx.taskText);
        const shouldRunTurn =
          start === "task" || (start === "resume" && awaitsReply(prepared.session.messages));
        // "resume" has no new user-typed text this run — its last message is already-existing
        // content the earlier session left unanswered, not something submitted just now.
        if (shouldRunTurn) {
          currentTurn = runTurn(prepared.session, start === "task" ? ctx.taskText : undefined);
        }
      },
    }),
  );

  // M-2: process.kill(pid, SIGINT) with no listeners left (raiseSignal, signals.ts's fatal
  // path) terminates before any more JS runs, which would otherwise leave the terminal in raw
  // mode — mirrors how the readline approval prompt already avoids this (closing the Interface
  // puts the tty back out of raw mode before a second press re-raises for real,
  // makeApprovalPrompt's own onAbort wiring). No `onSignalCleanup` registration needed here
  // anymore: `getTuiRenderer()` (this function's own top) already registers exactly this via
  // `onSignalCleanupLast` the moment the renderer is created, so it runs on every fatal signal
  // death this process can have, not just the ones a turn happens to be in flight for.

  return settled;
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (typeof parsed === "number") return parsed;
  const { values, positionals, maxTurns, skipPermissions } = parsed;
  // The override is already set — parseCliArgs does it before any of its own validation can
  // short-circuit with a usage error (see the comment there). Nothing to do here except rely on
  // it having happened before handleInfoFlags, runSelftest and all seven getConfigDir() consumers.

  const info = handleInfoFlags(values);
  if (info !== undefined) return info;

  if (values.selftest === true) return runSelftest(deps);

  // TTY-inferred, not a flag (plan Decision 2): a real terminal gets the Ink TUI, driving the
  // exact same driveLoop as the piped/CI path below — only how it reports events differs
  // (dispatch into App.tsx's reducer vs. printEvent called directly). Falsy — piped, CI, a
  // redirected file, or (deliberately) any caller that doesn't pass isTTY at all — takes the
  // untouched path this project has always run: same function, same call order, same output. See
  // CliDeps.isTTY's own comment for why this reads `deps.isTTY`, never process.stdout.isTTY
  // directly. Computed here, above the positionals.length===0 gate right below, so that gate can
  // fall through to the TUI on a TTY instead of hard-exiting.
  const isTTY = deps.isTTY ?? false;

  // Built here, before the positionals.length===0 gate right below, rather than after it as
  // before: the gate needs runStart(ctx)'s own answer, and RunContext's fields (deps.sessionsDir
  // etc.) are all already available — nothing between here and the old construction site fed into
  // it. `resumeId`/`resuming` and `taskText` are what the gate's OLD four-clause condition (removed
  // below) was hand-checking directly; runStart is now the one place that logic lives.
  const ctx: RunContext = {
    resuming: values.continue === true || values.resume !== undefined,
    resumeId: values.resume,
    // Trimmed once, here, not at each push/echo site: an untrimmed value (`seri "   "`) used to
    // read as non-empty (a bare `.length > 0` check) while the push site's OWN separate `.trim()`
    // then persisted an empty-content message anyway — a whitespace-only task. One trim, at construction, means every later
    // reader of `ctx.taskText` (runStart, the push, the echo) agrees on what "empty" means.
    taskText: positionals.join(" ").trim(),
    sessionsDir: deps.sessionsDir ?? join(getConfigDir(), "sessions"),
    checkpointsDir: deps.checkpointsDir ?? join(getConfigDir(), "checkpoints"),
    permissionsDir: deps.permissionsDir ?? getConfigDir(),
    // Matches prepareSession's own resolution (D7) so /memory and the archivist read the same
    // config.json / memories/ directory a /setup-written key or a config set just landed in.
    configDir: deps.authConfigDir ?? getConfigDir(),
    cwd: process.cwd(),
  };

  // Bare `seri` in a TTY mounts the TUI directly (idle, empty input box) instead of printing
  // usage. On a non-TTY caller, this gate's own behavior (USAGE / "No task given.") is unchanged
  // for the case every existing test already covers — no positionals at all. It now ALSO catches a
  // whitespace-only or empty-string positional (`seri "   "`, `seri ""`): `ctx.taskText` is trimmed
  // at construction (above), so `runStart` sees those the same as no task given, rather than
  // reaching prepareSession and persisting an empty-content user message — a real bug this closes,
  // not a byte-for-byte-unchanged case. Any other flags-but-no-task invocation (`seri --max-turns
  // 5`) on a non-TTY caller is still a usage error: unlike bare `seri`, it named an intention and
  // cannot be silently taken as "show usage".
  if (runStart(ctx) === "idle" && !isTTY) {
    if (argv.length === 0) {
      console.log(USAGE);
      return 0;
    }
    return usageError("No task given.");
  }

  const serve = await handleServeCommand(positionals, deps);
  if (serve !== undefined) return serve;

  const exec = await handleExecCommand(positionals, deps);
  if (exec !== undefined) return exec;

  if (isTTY) {
    // Wrapped, unlike the rest of this function's own `return N` early exits: `run()` has never had
    // a top-level `.catch` (its only caller, `import.meta.main`, does
    // `run(...).then((code) => process.exit(code))`), so an unwrapped throw here would print its own
    // stack trace INTO the still-active alt-screen buffer, which `getTuiRenderer`'s own renderer
    // (created by `runWelcomeSplash`, below) would otherwise leave undestroyed on the way out,
    // leaving the user with a dead process and zero visible diagnostics. `fatalDuringTui`
    // (prepareSession's own bailout, shared here) is what every other terminal-for-the-run failure
    // in this window already routes through — it destroys the renderer before printing, which is
    // safe to call even for a throw before the renderer was ever created (`destroyTuiRenderer`'s
    // own no-op guard). This try/catch is still what handles a throw/rejection reachable from THIS
    // block specifically — `runtime/renderer.ts`'s own `process.on("uncaughtException"/
    // "unhandledRejection", ...)` pair (registered once `getTuiRenderer` first creates the renderer)
    // is the backstop for one that isn't, not a replacement for this wrapper.
    try {
      await runWelcomeSplash(ctx.configDir, deps);
      const zeroKeysConfigured = checkZeroKeysConfigured(ctx.configDir);
      if (typeof zeroKeysConfigured === "number") return zeroKeysConfigured;
      // getModelCatalog() deliberately NOT awaited here: awaiting it before runGuidedSetup would
      // block /setup from ever painting until the models.dev fetch settled (up to
      // FETCH_TIMEOUT_MS) — a blank terminal on exactly the flow this feature exists to make
      // instant. The fetch still starts immediately; runGuidedSetup's own onSetupClose only consumes
      // the resolved catalog once it actually needs it, by which point a real user has almost always
      // already typed a key and closed the panel.
      //
      // This IS a fetch running in parallel with a live render — a hazard that loading the catalog
      // fully BEFORE `runGuidedSetup` ever mounted would avoid by construction instead. It is safe
      // here because
      // `@opentui/core`'s `CliRenderer` defaults `consoleMode` to `"console-overlay"` for the whole
      // renderer's lifetime, not just one mount — `getModelCatalog`'s own `printWarning` (a
      // `console.error` call, provider/catalog.ts) is captured rather than written to the live
      // alt-screen frame, on every offline first run. An explicit `consoleMode: "disabled"` on
      // `MAIN_TUI_RENDERER_CONFIG` (there is none today, runtime/renderOptions.ts) would reintroduce
      // that hazard.
      if (zeroKeysConfigured) {
        await runGuidedSetup(ctx.configDir, getModelCatalog());
      }
    } catch (err) {
      return fatalDuringTui(err);
    }
  }

  // prepareSession reports failure as a return value (its own comment: "nothing fallible in this
  // function can [throw uncaught] again by omission"), so the TTY and non-TTY paths need no
  // different handling here — both are covered by the `typeof prepared === "number"` check below.
  const prepared: PreparedRun | number = await prepareSession(ctx, deps, skipPermissions, isTTY);
  if (typeof prepared === "number") return prepared;

  // The non-interactive branch below still calls driveLoop unconditionally on a bare
  // `--continue`/`--resume` (no new task text) — the same redundant-turn defect
  // session/awaitsReply.ts's own comment describes for the TUI mount path above, left open here
  // deliberately: piped/scripted invocations are a separate, unaudited surface (their own usage
  // gate above only rejects `runStart(ctx) === "idle"`, not "resume"), and closing it needs its
  // own reproduction and test coverage rather than reusing the TUI-mount fix's evidence for a
  // different call site. Tracked as a known gap, not an oversight.
  let runResult: DriveLoopResult;
  if (isTTY) {
    // Same reasoning as the try/catch above this function's own welcome-splash/guided-setup block:
    // a throw out of runTui (a reducer bug, a rendering error, anything the renderer itself
    // doesn't already catch) would otherwise reach `import.meta.main`'s bare `.then`, print its
    // stack into the still-active alt-screen buffer, and lose it once the process exits with the
    // renderer never destroyed. `prepared.preMountMessages` is flushed here too, for the same
    // reason `prepareSession`'s own catches flush it: this IS the only other path that can end the
    // run before runTui's own `connectDispatch` ever gets a chance to.
    try {
      runResult = await runTui(prepared, ctx, deps, maxTurns, skipPermissions);
    } catch (err) {
      return fatalDuringTui(err, prepared.preMountMessages);
    }
  } else {
    runResult = await driveLoop(
      prepared,
      ctx,
      deps,
      maxTurns,
      printEvent,
      () => prepared.permissionMode,
      (session) => saveSession(session, ctx.sessionsDir),
      makeApprovalPrompt(deps.createInterface),
      createArchivistState(prepared.session),
    );
  }
  const { doneReason, cancelledBy, usage, cost, refusedWithoutRunning, archivist, ranAnyTurn } =
    runResult;

  // Already destroyed by runTui's own quit() (its `finishQuit`, the only place `runResult` can
  // resolve from on the TTY path) or never created at all on the non-TTY path — this call is a
  // no-op in both of today's cases. Kept as an explicit backstop, not deleted: `destroyTuiRenderer`
  // is idempotent, and the alternative is trusting every future TTY-path resolution to keep
  // routing through quit() with no second reminder here if that ever stops being true.
  destroyTuiRenderer();

  // Before raiseSignal, and outside the exit-code branch below, because every way out of driveLoop
  // spent the same tokens: a turn the user cancelled and a turn the provider failed mid-way are
  // billed for the calls they did make, and those are precisely the runs whose cost is otherwise
  // unaccounted for. The mid-stream failure reaches here because loop.ts reads that call's usage
  // before it returns — 907 tokens, measured, that this line would otherwise print without. The
  // one call nobody can report is an aborted one: the SDK rejects its usage promise with
  // AbortError, so a cancelled run reports every completed call before it and not that one. The
  // one exit this does not cover is a throw escaping driveLoop's `for await` (approvalPrompt
  // rejecting), which already skips the exit code below too.
  printUsage(usage);
  // Same guard printUsage's own callers get for free (a run that never called anything has
  // nothing to report): `cost` stays undefined until the first `usage` event carries one, which
  // only happens once opts.provider/modelId/catalog reach loop.ts at all (driveLoop's own runLoopFn
  // call, above) — HIGH-1's fix. `printCost` itself handles a report whose `amountUsd` came back
  // undefined (an id absent from the catalog, an OpenRouter response with no cost data).
  if (cost !== undefined) printCost(cost);
  // The archivist's own line, deliberately separate from the two above — driveLoop's own comment
  // on DriveLoopResult.archivist explains why its usage/cost are never folded into `usage`/`cost`.
  if (archivist) console.log(archivistLine(archivist));

  // The turn was cancelled, so the process still dies the way Ctrl-C makes a process die. Not
  // process.exit: a status is not a death by signal, and `for f in a b c; do seri "$f"; done` only
  // breaks out of the loop when the child was killed BY SIGINT — exiting 0 here would turn one
  // Ctrl-C into one press per iteration, the exact regression signals.ts's re-raise exists to
  // prevent. raiseSignal is that same re-raise, shared rather than re-implemented, and it does not
  // return, so the status below is for every other way this function ends.
  if (cancelledBy !== undefined) raiseSignal(cancelledBy);

  // Not "an error event was seen": loop.ts yields `error` and carries on at three sites, and a run
  // that recovered from a failed tool call and then answered the user did not fail. The status
  // answers one question — did the turn finish, and did it get anything past the gate? — and
  // `no-tool-call` is necessary but, since approve-each became the default, no longer sufficient:
  // a fresh session with no human present now reaches the approval prompt on its very first write,
  // EOF resolves "no", the model gives up and answers with text, and that used to exit 0 — asked
  // for permission, nobody was there, did nothing, reported success. `seri "…" && deploy` would
  // deploy. So within `no-tool-call`, `refusedWithoutRunning` — driveLoop's own conclusion from
  // "was anything DECLINED" and "did anything actually run", declined at least once AND executed
  // nothing at all — is exit 1 too. "Declined" is a live refusal (a "no" answer, or nobody there
  // to ask), not a `permission-denied` whose `reason` is "blocked" — a session in `read-only` that
  // gets a write probe refused is the mode doing exactly what the user selected, not a failure, so
  // `seri --resume x "review this repo" && open report.md` still exits 0 even if the model tries a
  // write mid-review and is correctly blocked. A run with no tools and no denials (`seri "explain
  // this repo"`) and a run where one call was declined but a later one ran (the user said no to
  // one thing, the model did something else) both still exit 0 too, because both are a completed,
  // accomplished turn, not a refusal the caller should treat as failure.
  //
  // A cap is not a finish: `max-iterations` yields `done` having stopped with the user's task
  // unanswered, and `seri "big task" && deploy` must not deploy. `repeated-denials` is the same
  // fact by the same reasoning — the run stopped itself after MAX_CONSECUTIVE_DENIALS declined tool
  // calls (unreachable in `read-only`, where nothing is ever declined — see MAX_CONSECUTIVE_DENIALS
  // in loop.ts), the task is exactly as unanswered as it would be at the iteration cap, and
  // `&& deploy` must not run off the back of it either — both stay unconditionally 1, regardless of
  // `refusedWithoutRunning`. loop.ts's two stream-error returns end the generator with no `done`
  // at all and land on the same 1 — a throw escaping runLoop outright (`approvalPrompt` rejecting, or
  // findSafeEvictionBoundary, neither of which is inside a try) ends it with no `done` too, but it
  // comes out of driveLoop's `for await` and never gets here. All of these used to exit 0 and let
  // `seri "…" && next` run next.
  //
  // `aborted` DOES reach this line now (HIGH-B, runTui's quit()): the TUI's own graceful-quit
  // cancels an in-flight turn via the exact same controller.abort() driveLoop's cancel handler
  // always used, but runTui's own resolve always passes `cancelledBy: undefined` for that
  // path — a deliberate quit is not the signal-death `raiseSignal` exists to re-raise — so it
  // lands on the `1` below instead of dying by signal, same as the displaced-slot case
  // tests/cli/cli.test.ts already records. signals.ts still names Stage 6's subagents as a
  // second aborter this same fallback would also cover, unchanged.
  //
  // `!ranAnyTurn` (bare `seri`, quit before ever submitting a task) is placed after the usage/cost/
  // signal handling above, but before the doneReason-based exit mapping below: `doneReason` stays
  // `undefined` for that session, and that mapping would otherwise fall through to the final
  // `return 1` and call an idle session the user simply closed a failure. `ranAnyTurn` is always
  // `true` on the non-interactive path (DriveLoopResult's own comment), where this never fires.
  return exitCodeFromDriveResult(runResult);
}

if (import.meta.main) {
  // The one place a real process.stdout.isTTY is read — see CliDeps.isTTY's own comment for why
  // run() itself never reads it directly.
  run(process.argv.slice(2), { isTTY: process.stdout.isTTY }).then((code) => process.exit(code));
}
