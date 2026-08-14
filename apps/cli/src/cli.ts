import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import {
  findCatalogEntry,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
} from "@seri/model-catalog";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import pkg from "../package.json";
import { onAbort } from "./abort";
import { loadAgentsFile as loadAgentsFileReal } from "./agents/loadAgentsFile";
import { buildSystemPrompt, buildVolatileTier, joinTiers } from "./agents/systemPrompt";
import { login as loginReal, logout as logoutReal } from "./auth/commands";
import { getWorkosClientId } from "./auth/deviceFlow";
import {
  appendBarrier,
  createCheckpointer,
  type RestorePlan,
  type RestoreResult,
} from "./checkpoint/checkpoint";
import { projectRoot } from "./checkpoint/shadowGit";
import { type OnBeforeMutation, withCheckpoints } from "./checkpoint/wrapTools";
import {
  approvalPromptText,
  archivistLine,
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
import { configCommand as configCommandReal } from "./config/commands";
import { loadVerifyConfig, setConfigValue, unsetConfigValue } from "./config/config";
import { getConfigDir, profileNameError, resolveProfile, setProfileOverride } from "./config/paths";
import type { PermissionMode } from "./gate/gate";
import {
  type ApprovalAnswer,
  type ApprovalPrompt,
  type LoopEvent,
  runLoop as runLoopReal,
} from "./loop/loop";
import {
  type ArchivistReport,
  type ArchivistState,
  createArchivistState,
  maybeRunArchivist,
  observeArchivistEvent,
  resetArchivistForRewind,
} from "./memory/archivist";
import { decideMemoryCommand, memoryCommandAccepts } from "./memory/commands";
import { loadMemory, type LoadedMemory } from "./memory/store";
import { permissionsCommand as permissionsCommandReal } from "./permissions/commands";
import { effectiveTools, loadGrants, PERSISTABLE_TOOLS, rememberGrant } from "./permissions/store";
import { getModelCatalog } from "./provider/catalog";
import type { CostReport } from "./provider/cost";
import type { getAnthropicModel as getAnthropicModelReal } from "./provider/anthropic";
import { DEFAULT_PROVIDER, persistDefaultModel, resolveDefaultModel } from "./provider/defaults";
import type { getGoogleModel as getGoogleModelReal } from "./provider/google";
import type { getGroqModel as getGroqModelReal } from "./provider/groq";
import {
  configuredProviders,
  PROVIDER_API_KEY_NAMES,
  PROVIDER_DISPLAY_NAMES,
  type ProviderKeyState,
  providerKeyState,
  tuiMissingKeyMessage,
} from "./provider/keys";
import { getModel } from "./provider/model";
import type { getOpenAIModel as getOpenAIModelReal } from "./provider/openai";
import type { getOpenRouterModel as getOpenRouterModelReal } from "./provider/openrouter";
import { type ResolvedRoute, resolveRoute } from "./provider/routing";
import { toolDefinitions } from "./provider/tools";
import { validateProviderKey } from "./provider/validate";
import {
  findMostRecentSession,
  loadSession,
  type SessionState,
  saveSession,
} from "./session/session";
import { deliverSignal, onSignalCancel, onSignalCleanup, raiseSignal } from "./signals";
import { withSubagents } from "./subagents/dispatch";
import { grep as grepReal } from "./tools/grep";
import { resolveRg, rgVersion } from "./tools/runRipgrep";
import {
  type CommandDirs,
  checkpointTarget,
  decideModeCycle,
  decideModelPickerOpen,
  decideRestore,
  decideRewind,
  decideSetupOpen,
  decideUndo,
} from "./tui/commands";
import { runGuidedSetup } from "./tui/guidedSetup";
import {
  type Dispatch,
  initialTuiState,
  type SetupState,
  type TuiState,
  tuiReducer,
} from "./tui/reducer";
import { withVerification } from "./verify/wrapTools";

type CliDeps = {
  runLoop?: typeof runLoopReal;
  getGroqModel?: typeof getGroqModelReal;
  // All five mirror getGroqModel exactly — getModel (provider/model.ts) dispatches to whichever
  // of the five a session's provider names, so a test injecting some but not others still gets
  // the real implementation for whichever provider it never exercises.
  getOpenRouterModel?: typeof getOpenRouterModelReal;
  getAnthropicModel?: typeof getAnthropicModelReal;
  getOpenAIModel?: typeof getOpenAIModelReal;
  getGoogleModel?: typeof getGoogleModelReal;
  loadAgentsFile?: typeof loadAgentsFileReal;
  sessionsDir?: string;
  checkpointsDir?: string;
  authConfigDir?: string;
  login?: typeof loginReal;
  logout?: typeof logoutReal;
  configCommand?: typeof configCommandReal;
  permissionsCommand?: typeof permissionsCommandReal;
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
} & (
  | {
      // Every command but /memory: `run` operates on a resumed session, so handleSlashCommand
      // (below) resolves one — an explicit --resume id or the most recent session — before calling
      // it, and fails with "No session to run <name> against" when none exists.
      needsSession?: true;
      // `presenter` is optional and defaults to consolePresenter at each command's own definition
      // (below) — handleSlashCommand's call site (unchanged) never passes one; the TUI entry
      // point's does. `void | Promise<void>`, not just `void`: cycleModeCommand/rewindCommand are
      // `async` now (they await presenter.sessionUpdated's own promise — CommandPresenter's own
      // comment), undo/restoreCommand are not and never need to be. Both call sites await this
      // either way, a no-op for the ones that were never async.
      run: (
        session: SessionState<ModelMessage>,
        args: string[],
        dirs: CommandDirs,
        presenter?: CommandPresenter,
      ) => void | Promise<void>;
    }
  | {
      // /memory: decideMemoryCommand's own I/O (config.json, the pending/ queue) is keyed on
      // configDir alone, never on a session (memoryCommand's own comment) — round-4 review finding:
      // routing it through the session-required branch above meant `seri /memory pending` on a
      // fresh profile, before any session had ever run, failed with "No session to run /memory
      // against" and exited 1, the same class of bug /exit's own fix (this table's comment, below)
      // addresses for a command that needs no session at all. This variant's `run` drops the
      // session parameter entirely rather than accepting one it would never read, so handleSlashCommand
      // can skip session resolution for it by construction, not by convention.
      needsSession: false;
      run: (
        args: string[],
        dirs: CommandDirs,
        presenter?: CommandPresenter,
      ) => void | Promise<void>;
    }
);

// A step count, or nothing at all.
function isStepCount(args: string[]): boolean {
  return args.length === 0 || (args.length === 1 && /^[1-9]\d*$/.test(args[0] ?? ""));
}

// Commands that operate on the resume target rather than being a task for the model. One table,
// so a new one is added in exactly one place: the dispatch in `run()` shares the resume-target
// resolution and the error reporting. Handlers throw to report a failure; the caller turns that
// into a message and a non-zero exit.
//
// A Map rather than an object literal, because an object literal inherits Object.prototype and a
// lookup keyed on user input walks it: `SLASH_COMMANDS["toString"]` returned a function, so
// `seri "toString is wrong on User, fix it"` dispatched Object.prototype.toString against the most
// recent session, printed nothing and exited 0 — the task never reached the model. `constructor`,
// `valueOf`, `hasOwnProperty` and `isPrototypeOf` did the same, and `__proto__` resolved to an
// object and crashed with "command is not a function". A Map has no prototype chain to walk, so
// the hazard is gone from every call site rather than from the ones that remember Object.hasOwn.
export const SLASH_COMMANDS = new Map<string, SlashCommand>([
  ["/mode", { accepts: (args) => args.length === 0, run: cycleModeCommand }],
  ["/undo", { accepts: isStepCount, run: undoCommand, mutatesRunState: true }],
  // A sha and nothing else. `seri "/restore the header spacing"` is a task.
  [
    "/restore",
    {
      accepts: (args) => args.length === 1 && /^[0-9a-f]{4,40}$/.test(args[0] ?? ""),
      run: restoreCommand,
      mutatesRunState: true,
    },
  ],
  ["/rewind", { accepts: isStepCount, run: rewindCommand, mutatesRunState: true }],
  // mutatesRunState: /memory approve|reject mutates the pending/ queue and the live memory files,
  // and must not race the archivist staging more writes mid-turn (C-7's own comment on why that
  // block runs before `finally` unregisters the cancel slot). Per-command, not per-subcommand
  // (accepted deliberately — SlashCommand's own field comment explains why a read-only
  // /memory pending shares the gate with a mutating /memory approve).
  [
    "/memory",
    {
      accepts: memoryCommandAccepts,
      run: memoryCommand,
      mutatesRunState: true,
      needsSession: false,
    },
  ],
]);

// MEDIUM-F: /exit is deliberately NOT a SLASH_COMMANDS entry — it used to be, with a no-op `run`
// for the non-interactive path, but handleSlashCommand (below) resolves a resume target for
// anything it matches: `seri /exit` with no session printed a nonsense "No session to run /exit
// against" and exited 1, and with a session it silently ran the no-op and exited 0 — the task
// never reached the model, exactly the hijack SlashCommand's own comment above says this table
// exists to prevent. /exit only means anything to a live TUI (there is nothing to "exit" in a
// process that is about to end anyway), so it is intercepted solely in runTui's own onSubmit,
// below, and documented in USAGE without a table entry backing it.

// The non-interactive presenter: exactly what every command printed inline before this refactor
// (console.log, plus undoPlanLines/recoveryLines — via their own default console.log sink — for
// /undo and /restore) — used by handleSlashCommand, unchanged observable output. A factory, not a
// plain object, because `sessionUpdated` now owns persistence (CommandPresenter's own comment) and
// needs `dirs` to call saveSession with — closed over here rather than threaded through a second
// way. `onPlan` is what makes the console path print the plan BEFORE undoFiles/restoreCommit
// mutate anything, restoring output.ts's own documented guarantee.
function consolePresenter(dirs: CommandDirs): CommandPresenter {
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
  // slash command's own `run` already sits inside (onSubmit's, handleSlashCommand's) — the
  // truncation is already persisted by this point, so surfacing the failure as this command's own
  // error, rather than silently swallowing it the way driveLoop's compaction-barrier warning
  // does, is the more honest signal: the barrier itself did not land, and a later /rewind may not
  // be able to cross this point.
  recordBarrier();
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

// `model`/`provider` are optional on SessionState so that sessions written before either field
// existed still load, but every session this function hands back has both — which is what lets the
// rest of the run stop asking, and getModel drop a default parameter for either.
type RunSession = SessionState<ModelMessage> & { model: string; provider: ModelProvider };

// `modelRecorded` says where the model came from: true if the session file already had one, false
// if it was just resolved from the environment and no provider call has confirmed it exists.
// prepareSession uses it to decide whether the creation-time save may persist it — see there.
function loadOrCreateSession(
  resuming: boolean,
  resumeId: string | undefined,
  sessionsDir: string,
  loadAgentsFileFn: typeof loadAgentsFileReal,
  configDir: string,
): { session: RunSession; modelRecorded: boolean } {
  if (resuming) {
    const id = resumeId ?? findMostRecentSession(sessionsDir);
    if (!id) throw new Error("No session to resume.");
    const loaded = loadSession<ModelMessage>(id, sessionsDir);
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
    // session written before the `provider` field existed, back when groq was the only provider —
    // and that case keeps its own narrower, unconditional backfill: absent means DEFAULT_PROVIDER
    // (SessionState.provider's own comment; DEFAULT_PROVIDER is "groq" today, the same value this
    // used to hardcode directly — imported instead so there is one source of truth for it),
    // independent of resolveDefaultModel().
    const { model, provider } =
      loaded.model === undefined
        ? resolveDefaultModel(configDir)
        : { model: loaded.model, provider: loaded.provider ?? DEFAULT_PROVIDER };
    return {
      session: {
        ...loaded,
        systemPrompt: buildSystemPrompt(loadAgentsFileFn(loaded.cwd)),
        model,
        provider,
      },
      modelRecorded: loaded.model !== undefined,
    };
  }

  // A brand-new session starts on whatever a previously successful `/model` pick persisted
  // (resolveDefaultModel's own comment), falling back to DEFAULT_MODEL/"groq" the same way
  // resolveModelId always has when nothing was ever picked.
  const { model, provider } = resolveDefaultModel(configDir);
  return {
    session: {
      id: randomUUID(),
      cwd: process.cwd(),
      systemPrompt: buildSystemPrompt(loadAgentsFileFn(process.cwd())),
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
  };
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
    return usageError(err instanceof Error ? err.message : String(err));
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
    // this check is not redundant. Same shape as isStepCount above. Validated here, right after the
    // parse, so a malformed value is a usage error regardless of which subcommand follows it —
    // `seri --max-turns garbage login` used to reach login with the bad flag silently ignored.
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
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function handleAuthCommand(
  positionals: string[],
  deps: CliDeps,
): Promise<number | undefined> {
  if (positionals[0] === "login" || positionals[0] === "signup") {
    const loginFn = deps.login ?? loginReal;
    try {
      const configDir = deps.authConfigDir ?? getConfigDir();
      await loginFn(positionals[0], getWorkosClientId(configDir), configDir);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    return 0;
  }
  if (positionals[0] === "logout") {
    const logoutFn = deps.logout ?? logoutReal;
    try {
      logoutFn(deps.authConfigDir ?? getConfigDir());
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    return 0;
  }
  return undefined;
}

function handleConfigCommand(positionals: string[], deps: CliDeps): number | undefined {
  if (positionals[0] !== "config") return undefined;
  const configCommandFn = deps.configCommand ?? configCommandReal;
  try {
    // Annotated and returned through a local, not `return configCommandFn(...)` directly. This
    // function's own return type has to admit `undefined` — that is how the dispatch in run() says
    // "not mine, carry on" — which means the compiler would accept an `undefined` arriving from
    // configCommand too, and run() would read it as "not handled". Before the decomposition this
    // call sat in `run(): Promise<number>` and widening it was a tsc error; the annotation is what
    // puts that error back. What it costs to lose is measured, not imagined: with a bare `return;`
    // added here, `seri config set GROQ_API_KEY gsk_live_…` falls through to the task path, mints a
    // session and writes `{"role":"user","content":"config set GROQ_API_KEY gsk_live_…"}` into the
    // session JSON — the key in full, on disk, and tsc stays green.
    const code: number = configCommandFn(
      positionals.slice(1),
      deps.authConfigDir ?? getConfigDir(),
    );
    return code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function handlePermissionsCommand(positionals: string[], deps: CliDeps): number | undefined {
  if (positionals[0] !== "permissions") return undefined;
  const fn = deps.permissionsCommand ?? permissionsCommandReal;
  try {
    // projectRoot(process.cwd()), not a session's cwd: there is no session here, and "this
    // project" for a bare command means the one you are standing in. A resumed session started
    // elsewhere is keyed on ITS cwd (checkpointTarget's own reasoning) — so `list` run from a
    // different project shows that project's grants, which is what its heading says it shows.
    const code: number = fn(
      positionals.slice(1),
      deps.permissionsDir ?? getConfigDir(),
      projectRoot(process.cwd()),
    );
    return code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// What the task path needs after the subcommands have had their say. It extends CommandDirs, so it
// satisfies the two callees that take one structurally — but it is not handed to them whole:
// `dirs(ctx)` below narrows it back down at each call. Structural typing makes passing the whole
// thing legal and silent, so a slash command handler that asks for two directories would in fact
// receive the resume target and the task text as well — and whatever it grew to read from them
// would still typecheck against a signature saying it needs neither. Narrowing at the call site is
// what keeps the callee's declared contract the true one.
type RunContext = CommandDirs & {
  resuming: boolean;
  resumeId: string | undefined;
  taskText: string;
  permissionsDir: string;
};

function dirs(ctx: RunContext): CommandDirs {
  return {
    sessionsDir: ctx.sessionsDir,
    checkpointsDir: ctx.checkpointsDir,
    configDir: ctx.configDir,
  };
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
//   "resume" — --continue/--resume with no new text: nothing to push or echo, but still
//              auto-starts a turn on the resumed session, same as it always has.
//   "idle"   — no resume target and no task text (bare `seri` in a TTY): mount with nothing to do.
type RunStart = "idle" | "task" | "resume";

function runStart(ctx: RunContext): RunStart {
  if (ctx.taskText.length > 0) return "task";
  return ctx.resuming ? "resume" : "idle";
}

// A slash command always operates on the resume target — an explicit --resume id, or the most
// recent session — and never creates a session just to act on it, so this is called before
// prepareSession and a bare `/undo` (no --resume) does not fall into the new-session path. `/undo`
// and `/rewind` are keyed on the session's own `cwd`, not the current one, so running them from a
// different directory still finds the store the edits were recorded in.
async function handleSlashCommand(ctx: RunContext): Promise<number | undefined> {
  const [name = "", ...commandArgs] = ctx.taskText.split(/\s+/).filter(Boolean);
  const command = SLASH_COMMANDS.get(name);
  if (command === undefined || !command.accepts(commandArgs)) return undefined;

  // needsSession: false (today, only /memory — SlashCommand's own comment) skips resume-target
  // resolution entirely: nothing below it reads a session, so requiring one to already exist would
  // only make the command fail on a fresh profile for no reason.
  if (command.needsSession === false) {
    try {
      await command.run(commandArgs, dirs(ctx));
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  const id = ctx.resumeId ?? findMostRecentSession(ctx.sessionsDir);
  if (!id) {
    console.error(`No session to run ${name} against.`);
    return 1;
  }
  try {
    // Awaited: cycleModeCommand/rewindCommand are `async` (SlashCommand.run's own comment) — not
    // awaiting here would let this function return before their own continuation (recordBarrier,
    // the final message) ran at all, since nothing else keeps the process alive for a background
    // continuation to finish in once run() returns and the real binary calls process.exit(code).
    await command.run(loadSession<ModelMessage>(id, ctx.sessionsDir), commandArgs, dirs(ctx));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// Everything the loop is driven with, resolved before the first model call so a failure to build
// any of it is an exit code rather than a half-started turn.
//
// Code-review finding: `session` used to be typed as the loose `SessionState<ModelMessage>`
// (model/provider optional) even though `prepareSession` (below) only ever builds a fully-resolved
// `RunSession` — forcing a defensive `?? "groq"` fallback and two bare `as RunSession` casts
// downstream to re-assert, by convention, an invariant the type already failed to state. `RunSession`
// here means a future code path that legitimately produces a session without model/provider (an
// import/migration path, say) is a compile error at its own call site, not a silent fallthrough.
type PreparedRun = {
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
  // The (model, provider) pair the run actually resolved to, per resolveRoute (D2/D3,
  // feature-plan.md's multi-provider-byok-phase-2) — NOT necessarily `session.model`/`.provider`,
  // which is what the session merely REQUESTED. runTui's own `confirmedModel`/`lastPersistedModel`
  // must initialize from this, not from `session`: starting them from the requested pair while
  // turn 1 actually runs on a rerouted one trips their inequality guards on turn 1 and persists a
  // switch the session never asked for — see those variables' own comments.
  route: ResolvedRoute;
  // The same OnBeforeMutation `tools`' own withCheckpoints was built with — driveLoop's
  // withSubagents reuses it for one pre-dispatch snapshot instead of building a second one.
  checkpointer: OnBeforeMutation;
  // Loaded once here, alongside everything else this object resolves once per run — "frozen per
  // session" (renderMemoryTier's own doc comment) means loaded HERE and nowhere else; a write made
  // mid-session takes effect next session, not this one.
  memory: LoadedMemory;
};

// Shared by prepareSession's own non-TTY notice and runTui's runTurn (below) — the two used to
// hand-duplicate this exact template literal (code-review finding, PR #73, round 2, item #8),
// differing only by a leading "↻ " on the TUI path (that one repeats per turn, so the arrow marks
// it as a live event rather than the one-time startup notice prepareSession prints).
//
// `requestedProvider` is a separate parameter, not `route.reason` (still exactly
// PROVIDER_API_KEY_NAMES[requestedProvider] — resolveRoute's own return value, unchanged, and
// still what routing.test.ts asserts directly): this notice is purely informational, no embedded
// command, so it reads better with a display name (PROVIDER_DISPLAY_NAMES) than the raw env var
// constant — unlike missingKeyError's message, which needs the exact name because it IS one.
function rerouteNotice(route: ResolvedRoute, requestedProvider: ModelProvider): string {
  return `routing ${route.model} via ${route.provider} (your key) — no ${PROVIDER_DISPLAY_NAMES[requestedProvider]} key configured`;
}

async function prepareSession(
  ctx: RunContext,
  deps: CliDeps,
  skipPermissions: boolean,
  isTTY: boolean,
): Promise<PreparedRun | number> {
  const loadAgentsFileFn = deps.loadAgentsFile ?? loadAgentsFileReal;
  // Resolved before loadOrCreateSession, not after (code-review finding, PR #73, round 3, item
  // #4): that function's own model/provider backfill (resolveDefaultModel) needs the SAME
  // configDir routing/getModel below already use, not the ambient default — a sandboxed
  // `authConfigDir` caller used to get session.model/session.provider read from the wrong
  // config.json entirely. `configDir` matches `seri config`'s own resolution (D7), so a key
  // `/setup` or `seri config set` just wrote is picked up on the very next run.
  const configDir = deps.authConfigDir ?? getConfigDir();

  let session: RunSession;
  let modelRecorded: boolean;
  try {
    ({ session, modelRecorded } = loadOrCreateSession(
      ctx.resuming,
      ctx.resumeId,
      ctx.sessionsDir,
      loadAgentsFileFn,
      configDir,
    ));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!ctx.resuming) console.log(`Session ${session.id} created.`);

  if (runStart(ctx) === "task") {
    session.messages.push({ role: "user", content: ctx.taskText });
  }

  // Loaded once, here, alongside the model resolution it feeds — /model (runTui's own runTurn)
  // reuses this SAME catalog on every later turn rather than reloading it, but @seri/model-catalog
  // caches for the rest of the process either way (catalog.ts's own loadCatalog).
  const catalog = await getModelCatalog();
  // D3 (feature-plan.md): resolveRoute sits ahead of getModel's dispatch, not inside it — getModel
  // stays a pure, environment-independent switch with its own test file.
  // Bug fixed here (code-review, PR #73): `configuredProviders` (called by `resolveRoute` below)
  // reads config.json — `getApiKey`'s own `loadConfig` call, which does a bare `JSON.parse` — so a
  // corrupted config.json throws SYNCHRONOUSLY, the same failure mode `getModel` itself already
  // guards against below. Before routing-priority resolution existed, that same read only ever
  // happened INSIDE getAnthropicModel/etc., already inside this try. Moving it inside here too is
  // what restores "a corrupted config.json prints a clean error and exits 1," not an uncaught
  // crash on every session start.
  let route: ReturnType<typeof resolveRoute>;
  let model: LanguageModel;
  try {
    route = resolveRoute(
      catalog,
      { model: session.model, provider: session.provider },
      configuredProviders(configDir),
    );
    model = getModel(
      route.model,
      route.provider,
      session.id,
      {
        getGroqModel: deps.getGroqModel,
        getOpenRouterModel: deps.getOpenRouterModel,
        getAnthropicModel: deps.getAnthropicModel,
        getOpenAIModel: deps.getOpenAIModel,
        getGoogleModel: deps.getGoogleModel,
      },
      configDir,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  // D2: a rerouted pair is never silent — the piped/non-interactive path gets the notice here,
  // gated on `!isTTY` — runTui's own runTurn (below) prints the TUI equivalent into the transcript
  // once per turn, and this call ALSO runs on the TUI path (this function has no other reason to
  // know isTTY), so without the gate a session-start reroute printed twice for the same turn: once
  // here (before Ink even mounts) and again from runTurn.
  if (route.rerouted && !isTTY) {
    printWarning(rerouteNotice(route, session.provider));
  }
  // D3's own consequence: findCatalogEntry on the RESOLVED pair, not the requested one — otherwise
  // cost and context-window come from the wrong provider's entry.
  const catalogEntry = findCatalogEntry(catalog, route.model, route.provider);

  // A model this run merely RESOLVED is deliberately left out of the file. getGroqModel accepts any
  // string — an unknown id is not rejected here, it comes back as a provider 404 mid-run — so
  // pinning at creation mints a session that can never succeed, and `--continue`, the obvious retry,
  // re-reads the bad id and fails identically while a corrected SERI_MODEL is ignored. driveLoop's
  // messages-updated save records it instead, which loop.ts only emits after a turn the provider
  // actually answered (loop.ts:264 for text, :276 for tool calls; a failure yields `error` and no
  // messages-updated at all), so what gets pinned is a model that demonstrably worked.
  //
  // opencode solves this upstream of the call, looking the id up in a provider catalog and failing
  // with `ModelNotFoundError` plus did-you-mean suggestions before anything is stored. seri has no
  // catalog until Stage 7a, so "pin only what answered" is the catalog-free half of that guarantee.
  // A model the session already recorded is untouched: it earned its place the same way.
  saveSession(modelRecorded ? session : { ...session, model: undefined }, ctx.sessionsDir);

  // Checkpointing is enabled by exactly this call, which is also why rolling it back is a one-line
  // revert: `runLoop`, the session store, the gate and every tool are unmodified, and the store
  // lives entirely outside the user's repository.
  const { storeDir, worktree } = checkpointTarget(session, dirs(ctx));

  // Read here and nowhere else. NOTE FOR A FUTURE SCHEDULER (docs/BUILD-PLAN.md, "Unattended
  // permission surface" open item): an unattended run must NOT copy this line. Every entry in
  // that file was written by a human answering a live prompt in a run they were watching; that
  // is consent for that run, not standing consent for one on a timer. Seeding a scheduled run
  // from here is docs/ARCHITECTURE.md:202's "base safety layer disabled on a timer" arriving
  // through a file instead of a flag.
  const grants = loadGrants(ctx.permissionsDir, worktree, printWarning);
  const allowedTools = effectiveTools(grants);
  const permissionMode = skipPermissions ? "auto" : session.permissionMode;
  // approve-each only: in read-only the gate blocks these tools before it ever consults the
  // allowlist (gate.ts:14), and in auto everything is allowed anyway — printing "pre-approved" in
  // either would be a sentence the run does not honour.
  if (permissionMode === "approve-each" && allowedTools.length > 0) printPreApproved(allowedTools);

  // `write_file`, `bash` and `powershell` write relative to process.cwd(), while the snapshot
  // covers the project root. Anywhere inside the project is fine — that is the whole point of
  // resolving the root, and it is why a subdirectory launch no longer trips this. What is left is
  // a genuine cross-project resume: it would snapshot one project while the tools edit another,
  // and a later /undo would run its removal pass in the ORIGINAL project, deleting untracked files
  // a human made there. Said out loud rather than left to be discovered by the deletion.
  const inProject = relative(worktree, process.cwd());
  if (inProject === ".." || inProject.startsWith(`..${sep}`) || isAbsolute(inProject)) {
    printWarning(
      `this session's files are checkpointed under ${worktree}, but tools run in ${process.cwd()} — /undo will act on ${worktree}`,
    );
  }

  // Verification is enabled by exactly this composition, and rolling it back is deleting the outer
  // call: `runLoop`, the gate, the session store and every tool are unmodified, and `verify/`
  // becomes dead code rather than something that has to be unpicked.
  //
  // Outside withCheckpoints, not inside: the checkpoint has to be taken BEFORE the write
  // (checkpoint/wrapTools.ts:18-22) and the check has to run AFTER it, so this is the order that
  // puts each on the correct side. The AbortSignal the check is run with is the one runLoop hands
  // `execute` (loop.ts:331), which is driveLoop's controller — the same Ctrl-C that stops a bash
  // command stops a check.
  const checkpointer = createCheckpointer({
    storeDir,
    worktree,
    sessionId: session.id,
    onWarning: printWarning,
  });
  const tools = withVerification(
    withCheckpoints(toolDefinitions, checkpointer),
    loadVerifyConfig(),
  );

  // Loaded once, here, alongside everything else this function resolves once per run — this is
  // what "frozen per session" means (memory/store.ts's own renderMemoryTier doc comment).
  const memory = loadMemory({ configDir, worktree });

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
    checkpointer,
    memory,
  };
}

type DoneReason = Extract<LoopEvent, { type: "done" }>["reason"];

// Shared by confirmedModel's and lastPersistedModel's own guards (both inside runTui, below) —
// hand-duplicating `a.model !== b.model || a.provider !== b.provider` at each site was the same
// comparison typed twice with two different variable names.
function modelPairChanged(
  a: { model: string; provider: ModelProvider },
  b: { model: string; provider: ModelProvider },
): boolean {
  return a.model !== b.model || a.provider !== b.provider;
}

// undefined + n is n, not NaN, and undefined + undefined stays undefined: a run's total is the sum
// of the calls that reported, and stays unreported if none did.
function addTokens(total: number | undefined, reported: number | undefined): number | undefined {
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

type DriveLoopResult = {
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
  // Always true from driveLoop's own return, below — reaching it means a turn ran, unconditionally.
  // runTui's own resolveRunTui (quit(), further down) is the one caller that can genuinely produce
  // `false` here: an idle TUI session the user quit without ever submitting a task never calls
  // driveLoop at all, so its own closure copy of this flag stays at its initial `false`. Not
  // optional — driveLoop setting it unconditionally is what makes `false` mean exactly one thing
  // (nothing ever ran) instead of also being read as "the non-interactive caller didn't bother."
  ranAnyTurn: boolean;
};

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
// ctx.sessionsDir)`, unchanged. The TUI path passes a no-op: MEDIUM-1 found that even a CORRECT
// merge dispatched to the reducer still left a ~6ms window where this function's own direct write
// (using the session the CURRENT turn started with) was the last word on disk, since the reducer's
// own onSessionChange effect corrects it asynchronously, not synchronously — a crash, a fatal
// Ctrl-C or a SIGTERM landing in that window still persisted a reverted /mode. A no-op here closes
// the window entirely rather than narrowing it: the reducer (via App.tsx's onSessionChange) is the
// ONLY writer on the TUI path, full stop.
//
// `approvalPrompt` is the other per-caller swap, findings 1+5 (thermo-nuclear structural review,
// round 6): this used to be hardcoded to `makeApprovalPrompt(deps.createInterface)` inside this
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
async function driveLoop(
  prepared: PreparedRun,
  ctx: RunContext,
  deps: CliDeps,
  maxTurns: number | undefined,
  onEvent: (event: LoopEvent) => void,
  getPermissionMode: () => PermissionMode,
  persist: (session: SessionState<ModelMessage>) => void,
  approvalPrompt: ApprovalPrompt,
  // Stage 6b: the tool-call counter/message cursor the archivist trigger reads and advances — one
  // instance per run, created once (createArchivistState) by this function's two callers, not
  // rebuilt here, so the counter accumulates across every turn of a TUI session rather than
  // resetting on each driveLoop call.
  archivistState: ArchivistState,
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

  // The controller lives here, not in the loop: runLoop is a library that is handed a signal, and
  // the consumer is the only thing that knows what a Ctrl-C means. The first press lands in
  // signals.ts's cancel slot, aborts the turn, and the loop unwinds far enough to yield a final
  // messages-updated — which the body below persists, so the session left behind is resumable. The
  // second press finds the slot empty and takes the file's untouched fatal path.
  const controller = new AbortController();
  let cancelledBy: NodeJS.Signals | undefined;
  const unregisterCancel = onSignalCancel((signal) => {
    cancelledBy = signal;
    controller.abort();
  });

  let doneReason: DoneReason | undefined;
  const usage: RunUsage = { inputTokens: undefined, outputTokens: undefined };
  let cost: CostReport | undefined;
  // Hoisted so this and runLoopFn's own `system` opt below are the exact same value. Recomputed
  // every driveLoop call (once per TUI turn, once per non-interactive process), from the RESOLVED
  // model/provider (`route`, D3/D4 feature-plan.md) — never captured once at session start, so a
  // live /model switch OR a routing-priority reroute is reflected on the very next turn instead of
  // confabulated. `route`, not `session.model`/`.provider`: `session` carries what was REQUESTED,
  // and a rerouted turn's system prompt/cost provenance must name the model actually being called,
  // not the one that was asked for and silently rerouted away from.
  const system = joinTiers(
    session.systemPrompt,
    buildVolatileTier(route.model, route.provider, catalogEntry?.displayName, memory),
  );
  // The one composition that enables dispatch_subagents; deleting this call (tools -> baseTools)
  // is the whole rollback, matching withCheckpoints/withVerification's own comment in prepareSession.
  const tools = withSubagents(baseTools, {
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
    // Folds every child's usage/cost into the SAME accumulators the runLoopFn loop below uses, so
    // subagent tokens land in the run's own reported total instead of vanishing.
    onChildUsage: (childUsage, childCost) => {
      usage.inputTokens = addTokens(usage.inputTokens, childUsage.inputTokens);
      usage.outputTokens = addTokens(usage.outputTokens, childUsage.outputTokens);
      cost = addCost(cost, childCost);
    },
  });
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
      // The seed runLoop has accepted since PR #45 and nothing produced until now. A seed, not a
      // handle: the loop copies it (loop.ts:211) and growth comes back out as `tool-allowed`,
      // below.
      allowedTools,
      approvalPrompt,
      // Computed once above, so a live /model switch or reroute reaches subagents identically.
      system,
      signal: controller.signal,
      maxIterations: maxTurns,
      // HIGH-1: without these three, loop.ts's own cost branch (`opts.provider === "openrouter"`
      // / `opts.provider === "groq" && opts.modelId && opts.catalog`) never fires and every `usage`
      // event's `cost` field is silently undefined — the run genuinely never computes a cost, no
      // matter what cost.ts itself does. No `?? "groq"` fallback needed here (a prior version had
      // one): `route` (PreparedRun's own field) is never optional — `resolveRoute` always returns a
      // concrete pair. `route.model`/`.provider`, not `session.model`/`.provider`: this is the
      // pair the call is ACTUALLY being made against (this function's own comment just above), and
      // the two can differ from a routing-priority reroute (D2/D3) — using the requested pair here
      // would mis-tag a rerouted call's cost report with the wrong provider's pricing branch.
      provider: route.provider,
      modelId: route.model,
      catalog,
      // The catalog's own contextWindow for whatever model this turn is actually calling — a
      // /model switch to a provider/model with a different limit must change compaction's own
      // math, not just which endpoint gets called (PreparedRun.catalogEntry's own comment).
      contextWindowSize: catalogEntry?.contextWindow,
    })) {
      // The archivist's entire view of this turn — its own module owns what each event means to
      // it (memory/archivist.ts's own comment on observeArchivistEvent), so nothing else in this
      // loop mutates archivistState directly.
      observeArchivistEvent(archivistState, event);
      if (event.type === "messages-updated") {
        // `persist` (this function's own comment above explains the two callers) is the ONLY
        // write for this event now — MEDIUM-1: driveLoop used to ALSO call saveSession directly
        // here, using the session THIS call started with, and rely on the TUI path's reducer to
        // correct it moments later; that left a real, if narrow, crash/fatal-signal window where
        // the stale write was the last one on disk. No direct saveSession call here anymore.
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
        } catch (err) {
          printWarning(
            `could not record the compaction barrier, so /rewind may not be able to cross this point: ${err instanceof Error ? err.message : String(err)}`,
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
            `could not save the permanent approval for ${event.name}, so seri will ask again next time: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Inside the same try, before `finally` unregisters the cancel slot: the archivist's own child
    // runLoop must share `controller.signal` while that slot is still registered, per the
    // one-cancel-stops-everything contract every dispatch_subagents child already relies on.
    // maybeRunArchivist (memory/archivist.ts) owns the out-of-bounds cursor guard, the live
    // /memory archivist toggle read, and the trigger check — cli.ts carries none of that itself.
    archivist = await maybeRunArchivist({
      state: archivistState,
      ctx: { configDir: ctx.configDir, worktree },
      contextWindow: catalogEntry?.contextWindow,
      model,
      route,
      catalog,
      signal: controller.signal,
      onWarning: printWarning,
    });
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

// A plain default-flush transcript-append, shared by tuiPresenter's own `append` below and
// runTui's quit() — the only two places that dispatch this exact shape rather than something with
// its own `> `/`flush: false` handling (echoUserInput, a different shape entirely, is not this).
function pushTranscriptLine(dispatch: Dispatch, line: string): void {
  dispatch({ type: "transcript-append", line });
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
function tuiPresenter(dispatch: Dispatch, awaitPersist: () => Promise<void>): CommandPresenter {
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
  };
}

// D5-D8 (feature-plan.md): /setup's own five handlers, mirroring the /model pair above — each
// does nothing but recompute the current truth (decideSetupOpen re-reads config.json/env every
// time, never trusting a stale copy) and dispatch it. `setupListState` is the one piece shared
// by every path that returns to the list step: fresh rows, plus — when a specific provider is
// named — that row's own index, so returning from enter-key/confirm-remove re-highlights the row
// the user was just looking at instead of always snapping back to the top.
//
// Extracted (byok-guided-setup, feature-plan.md) so both `runTui` and the blank-first-run
// bootstrap (`runGuidedSetup`, tui/guidedSetup.ts — threaded this factory in as a parameter rather
// than importing it there, code-review finding PR #91 round 2) share one copy of this logic rather
// than diverging over time. `getPendingSetup` is a live accessor (not a captured snapshot) — each
// caller passes in a closure that reads its own current reducer state, matching the semantics
// `liveState.pendingSetup` had before this extraction.
function createSetupHandlers(opts: {
  dispatch: Dispatch;
  getPendingSetup: () => SetupState | undefined;
  configDir: string;
}): {
  onSetupSelect: (provider: ModelProvider) => void;
  onSetupKeyEntered: (provider: ModelProvider, value: string) => Promise<void>;
  onSetupRemove: (provider: ModelProvider) => void;
  onSetupBack: () => void;
} {
  const { dispatch, getPendingSetup, configDir } = opts;

  function setupListState(selectedProvider?: ModelProvider): SetupState {
    const rows = decideSetupOpen(configDir);
    const selected =
      selectedProvider === undefined
        ? 0
        : Math.max(
            0,
            rows.findIndex((row) => row.provider === selectedProvider),
          );
    return { step: "list", rows, selected };
  }

  // A shared "refresh the list, degrade to command-error if that throws" primitive (code-review
  // finding, PR #73, round 2): decideSetupOpen reads config.json, and a malformed file is exactly
  // as reachable once the panel is already open (a racing second `seri` process, a hand edit) as it
  // is at the /setup-OPEN interceptor above — which the round 1 fix already guarded. Used by
  // onSetupRemove's success path and onSetupBack — round 1 missed both, reached only from INSIDE an
  // already-open panel, with nothing above them to catch a throw out of their own `useInput`
  // callback. NOT used by onSetupKeyEntered's own success path (round 3, item #3): that one needs
  // its OWN inline catch instead, to reset `busy: false` on a refresh failure rather than just
  // showing a command-error while leaving the panel's own busy gate stuck — see its own comment.
  function dispatchSetupList(selectedProvider?: ModelProvider): void {
    try {
      dispatch({ type: "setup-step", state: setupListState(selectedProvider) });
    } catch (err) {
      dispatch({
        type: "command-error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // No config.json read here at all (code-review finding, PR #73, round 2): a row's `keyName` is a
  // pure function of `provider` (PROVIDER_API_KEY_NAMES), so the old `decideSetupOpen(configDir).
  // find(...)` — the full 5-provider scan, just to pull one static field back out of it — was both
  // slower and a needless crash surface for a value that never needed I/O to produce.
  function onSetupSelect(provider: ModelProvider): void {
    dispatch({
      type: "setup-step",
      state: {
        step: "enter-key",
        provider,
        keyName: PROVIDER_API_KEY_NAMES[provider],
        busy: false,
      },
    });
  }

  // D5's own probe, then D6's own write — `validateProviderKey` never throws (its own contract:
  // every failure mode resolves to a result, not a rejection), so only the config write itself
  // needs a try/catch, matching the persist path's degrade-to-a-message posture (onSessionChange's
  // own comment, above) rather than converting a validated key into a lost one over an unrelated
  // write failure.
  //
  // `keyName` is PROVIDER_API_KEY_NAMES[provider] directly, not a decideSetupOpen scan (code-review
  // finding, PR #73, round 2 — same fix as onSetupSelect just above): no config.json read here at
  // all, which is also what makes the rest of this function need no crash guard of its own.
  async function onSetupKeyEntered(provider: ModelProvider, value: string): Promise<void> {
    const keyName = PROVIDER_API_KEY_NAMES[provider];
    dispatch({
      type: "setup-step",
      state: { step: "enter-key", provider, keyName, busy: true },
    });
    const result = await validateProviderKey(provider, value);
    if (!result.ok) {
      dispatch({
        type: "setup-step",
        state: { step: "enter-key", provider, keyName, busy: false, error: result.message },
      });
      return;
    }
    try {
      setConfigValue(keyName, value, configDir);
    } catch (err) {
      // Bug fixed here (code-review, PR #73): this used to dispatch a bare command-error and
      // return, leaving `pendingSetup` stuck at `busy: true` — SetupEnterKey's own useInput
      // checks `if (busy) return;` BEFORE its Escape/Ctrl-D handling, so a write failure here
      // (EACCES, disk full, the config dir removed mid-session) permanently locked the /setup
      // panel with no way out short of a fatal Ctrl-C that kills the whole process. Re-rendering
      // `enter-key` with `busy: false` and an error, the same shape a validation failure already
      // uses above, is what actually returns control to the user.
      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider,
          keyName,
          busy: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }
    dispatch({
      type: "transcript-append",
      line:
        result.warning === undefined
          ? `Saved ${keyName}.`
          : `Saved ${keyName}. ⚠ ${result.warning}`,
    });
    // NOT dispatchSetupList (code-review finding, PR #73, round 3, item #3): that helper's own
    // catch only dispatches command-error, which never touches `pendingSetup` — leaving THIS
    // function's own `busy: true` (set above, before the validate/write round-trip) stuck forever
    // if the refresh read (setupListState -> decideSetupOpen -> config.json) throws, the exact
    // lockout class the write-failure catch above already fixed, just reached by a different
    // trigger (the post-write refresh failing, not the write itself). Resetting `busy: false`
    // here, inline, the same shape that catch already uses, is what actually clears it —
    // SetupEnterKey's own `if (busy) return;` gate is what makes that necessary.
    try {
      dispatch({ type: "setup-step", state: setupListState(provider) });
    } catch (err) {
      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider,
          keyName,
          busy: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // D8: this is the SAME prop SetupList's own 'r' keypress and SetupConfirmRemove's own 'y'
  // keypress both call — App.tsx has only five /setup props total, no separate "request
  // confirmation" one — so which one this call means is read off the CURRENT live reducer state,
  // the same "trust liveState, not a caller-captured copy" pattern this closure already uses
  // throughout (this function's own top comment).
  function onSetupRemove(provider: ModelProvider): void {
    const pending = getPendingSetup();
    if (pending?.step === "confirm-remove") {
      const { keyName } = pending;
      try {
        unsetConfigValue(keyName, configDir);
      } catch (err) {
        dispatch({
          type: "command-error",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      dispatch({ type: "transcript-append", line: `Removed ${keyName}.` });
      dispatchSetupList(provider);
      return;
    }
    // `providerKeyState` for the one provider under the cursor, not a decideSetupOpen scan of all
    // five (code-review finding, PR #73, round 2) — still real I/O (config.json), so still needs
    // its own guard: a malformed file here used to throw straight out of this `useInput` callback,
    // the same class of bug round 1 fixed for the /setup-OPEN interceptor but missed here.
    let state: ProviderKeyState;
    try {
      state = providerKeyState(provider, configDir);
    } catch (err) {
      dispatch({
        type: "command-error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!state.hasConfigEntry) return;
    dispatch({
      type: "setup-step",
      state: { step: "confirm-remove", provider, keyName: state.keyName },
    });
  }

  function onSetupBack(): void {
    const current = getPendingSetup();
    const provider =
      current !== undefined && current.step !== "list" ? current.provider : undefined;
    dispatchSetupList(provider);
  }

  return { onSetupSelect, onSetupKeyEntered, onSetupRemove, onSetupBack };
}

// `boolean | number` mirrors this file's own established convention for a check that's usually a
// plain result but sometimes an exit code (prepareSession, handleAuthCommand, handleConfigCommand,
// handlePermissionsCommand, handleSlashCommand all return `T | number` for the identical reason) —
// callers check `typeof result === "number"` and return it directly on a throw. Used once, by
// run()'s own guided-setup gate, to decide whether to mount runGuidedSetup at all — no re-check
// after it returns (round 4): that fell through to prepareSession's own identical
// configuredProviders/missing-key handling instead, rather than duplicating this corrupted-config
// try/catch and its error-formatting a second time.
function checkZeroKeysConfigured(configDir: string): boolean | number {
  try {
    return configuredProviders(configDir).size === 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// Mounted only when deps.isTTY is true (run()'s own branch, above driveLoop's other call site —
// see CliDeps.isTTY's own comment for why that reads a passed-in flag, not a live
// process.stdout.isTTY). Drives the SAME driveLoop the non-interactive path uses for the initial
// task already appended to `prepared.session.messages` by prepareSession — only how it reports
// events differs. Slash commands typed into the TUI's input box reuse the exact same command
// functions (cycleModeCommand etc.) the non-interactive path uses, via tuiPresenter instead of
// consolePresenter — one decision function, two presentations, per the research spec.
//
// `ink` (and everything that transitively pulls it in, tui/App.tsx included) is imported lazily,
// here, rather than at this file's top level: reconciler.js has a module-load-time check —
// `if (process.env['DEV'] === 'true') { …; await import('./devtools.js'); }`, unconditional, not
// gated behind an actual render() call — so a top-level `import … from "ink"` ran that check (and
// attempted a react-devtools-core connection under DEV=true) on every invocation of this binary,
// `seri --version` and every piped/non-interactive command included, regardless of whether this
// function is ever reached. Confirmed both ways: DEV=true seri --version attempting a devtools
// connection before this fix, and not attempting one after it.
async function runTui(
  prepared: PreparedRun,
  ctx: RunContext,
  deps: CliDeps,
  maxTurns: number | undefined,
  skipPermissions: boolean,
): Promise<DriveLoopResult> {
  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { App } = await import("./tui/App");

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
  let liveState: TuiState = initialTuiState(prepared.session);
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
  // skipped.
  const echoUserInput = (text: string): void =>
    dispatch({ type: "transcript-append", line: `> ${text.trim()}`, flush: false });
  let turnInFlight = false;
  // HIGH-B: the currently in-flight turn's own promise (a fresh one assigned at each of the two
  // call sites that start one, both guarded so a new turn is never started while one is already
  // running — see runTurn's own comment). quit() awaits this when a turn is in flight instead of
  // abandoning it, so cancelling on the way out actually unwinds before the quit sequence runs.
  // The initial value is never awaited for real: quit() only reads it when turnInFlight is true,
  // which is only ever set by an assignment to this variable first.
  let currentTurn: Promise<void> = Promise.resolve();
  // LOW-G: without this, a second /exit or Ctrl-D while quit() is already unwinding a cancelled
  // turn would re-enter instance.rerender()/waitUntilExit() on an instance already mid-teardown —
  // Ink's own render() has no guard against that itself.
  let quitting = false;

  // HIGH-1: accumulated across every turn this TUI session runs (addTokens, the same summing
  // driveLoop itself does within one turn), not just the last one — a multi-turn session's own
  // usage/cost summary should total the whole session, not whichever turn happened to be running
  // when the user quit. `doneReason`/`refusedWithoutRunning` are NOT accumulated — the exit code
  // they drive (run()'s own logic, unchanged) is about the LAST turn's outcome, the same as it
  // always answered "did the run just now finish, and how."
  let usage: RunUsage = { inputTokens: undefined, outputTokens: undefined };
  let cost: CostReport | undefined;
  let doneReason: DoneReason | undefined;
  let refusedWithoutRunning = false;
  // Same "last turn's outcome" reasoning as doneReason/refusedWithoutRunning, just above — a turn
  // with nothing to report simply leaves this undefined again. runTurn (below) also renders every
  // non-undefined report live into the transcript, the moment it happens, via archivistLine; this
  // copy is what lets the FINAL resolveRunTui result carry one too, printed once more after Ink
  // unmounts, the same way `usage`/`cost` already print again there.
  let archivist: ArchivistReport | undefined;
  // This closure's own copy of DriveLoopResult.ranAnyTurn (see that field's own comment) — flipped
  // true the moment runTurn actually starts a turn (not on the early-return guard below it), so an
  // idle session the user quit without ever submitting a task never flips it.
  let ranAnyTurn = false;
  // Created ONCE per run, outside the per-turn loop, so the tool-call counter accumulates across
  // every turn of this TUI session rather than resetting each time runTurn calls driveLoop.
  const archivistState = createArchivistState(prepared.session);

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
      const message = `could not save the session: ${err instanceof Error ? err.message : String(err)}`;
      printWarning(message);
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

  // LOW-3: render() now runs before the promise executor (below), not inside it, so `instance` is
  // a plain `const` fully assigned before any code that reads it (runTurn's catch, quit()) can
  // possibly run — those are only ever reached from an Ink effect, which cannot fire until this
  // synchronous render() call has already returned. Previously `instance` was a `let` assigned
  // inside the executor, safe only because render() happened to complete synchronously before any
  // microtask could drain — true, but an accident of execution order rather than something the
  // structure itself guaranteed.
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
    pick: { model: string; provider: ModelProvider },
    leftoverInput?: string,
  ): void {
    dispatch({ type: "model-picker-resolved", pick, leftoverInput });
  }

  function onModelPickerCancel(): void {
    dispatch({ type: "model-picker-resolved" });
  }

  const { onSetupSelect, onSetupKeyEntered, onSetupRemove, onSetupBack } = createSetupHandlers({
    dispatch,
    getPendingSetup: () => liveState.pendingSetup,
    configDir,
  });

  function onSetupClose(leftoverInput?: string): void {
    dispatch({ type: "setup-resolved", leftoverInput });
  }

  // Runs one turn against whatever `session` is (the initial task on first call; the live
  // session plus a newly-submitted task on every later one — H-3), using the same dispatch the
  // reducer and driveLoop have always shared. Guarded against overlap: a second Enter press
  // while a turn is still running must not start a competing driveLoop call, which would fight
  // the first over signals.ts's single cancel slot. MEDIUM-1: the TUI path passes a no-op
  // `persist` — the reducer (via onSessionChange above) is the only writer now.
  async function runTurn(session: SessionState<ModelMessage>): Promise<void> {
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
    const {
      id: sessionId,
      model: requestedModel,
      provider: requestedProvider,
    } = session as RunSession;
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
    let route: ReturnType<typeof resolveRoute>;
    let model: LanguageModel;
    try {
      route = resolveRoute(
        prepared.catalog,
        { model: requestedModel, provider: requestedProvider },
        configuredProviders(configDir),
      );
      model = getModel(
        route.model,
        route.provider,
        sessionId,
        {
          getGroqModel: deps.getGroqModel,
          getOpenRouterModel: deps.getOpenRouterModel,
          getAnthropicModel: deps.getAnthropicModel,
          getOpenAIModel: deps.getOpenAIModel,
          getGoogleModel: deps.getGoogleModel,
        },
        configDir,
      );
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
    if (route.rerouted) {
      dispatch({
        type: "transcript-append",
        line: `↻ ${rerouteNotice(route, requestedProvider)}`,
      });
    }
    // D3's own consequence: findCatalogEntry on the RESOLVED pair, not the requested one.
    const catalogEntry = findCatalogEntry(prepared.catalog, modelId, provider);
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
    try {
      const result = await driveLoop(
        turnPrepared,
        ctx,
        deps,
        maxTurns,
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
                const message = err instanceof Error ? err.message : String(err);
                printWarning(`could not save the default model: ${message}`);
              }
            }
          }
        },
        getPermissionMode,
        () => {},
        tuiApprovalPrompt,
        archivistState,
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
      // comment explains why).
      if (result.archivist) {
        pushTranscriptLine(dispatch, archivistLine(result.archivist));
      }
      // LOW-J: `result.cancelledBy` is deliberately not read here. The TUI never re-raises a
      // signal on a plain, individually-cancelled turn (H-3 returns it to awaiting input, not to
      // process death) — only quit()'s own resolve decides `cancelledBy` for the run as a whole,
      // and it always passes `undefined`, since even a turn quit() itself cancelled first
      // (HIGH-B) ends the *session* by choice, not by a signal the shell needs to see re-raised.
    } catch (err) {
      // H-2: driveLoop rejecting (not just resolving with an aborted/errored `done`) used to
      // leave this promise — and run()'s own `await runTui(...)` — hanging forever. Unmount
      // first so raw mode is restored (M-2's own mechanism, mirrored here rather than relying
      // solely on the fatal-signal cleanup below, since a rejection is not a signal), then
      // reject, so run() actually settles instead of hanging.
      instance.unmount();
      rejectRunTui(err instanceof Error ? err : new Error(String(err)));
    } finally {
      turnInFlight = false;
    }
  }

  // HIGH-1: the ONLY way this function's outer promise ever resolves (as opposed to rejecting, or
  // the process dying by signal on the fatal Ctrl-C path — see onCancel below). Before this
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
  function quit(): void {
    if (reactDispatch === undefined || quitting) return;
    quitting = true;
    // Finding 2 (round 7 code review): Ctrl-D used to be silently swallowed while ApprovalBox was
    // mounted instead of InputBox. Denying the pending approval is folded into the SAME graceful
    // quit sequence — not a separate "deny just this one prompt" path the way the old
    // readline-based prompt's own Ctrl-D-at-empty-line handling worked — so Ctrl-D keeps one
    // consistent meaning everywhere in the TUI. The turn this unblocks is still in flight
    // afterward (a denied approval is not a finished turn), so the turnInFlight branch below
    // still runs exactly as it would for any other in-flight-turn quit.
    if (liveState.pendingApproval !== undefined) onApprovalAnswer("no");
    const finishQuit = (): void => {
      instance.rerender(
        createElement(App, {
          // LOW-J: inert after mount — App only reads `session` once, via useReducer's lazy
          // initializer, so this rerender's value is never actually read. Passed anyway because
          // the prop is required and `liveState.session` is the accurate value if that ever
          // changes.
          session: liveState.session,
          route: prepared.route,
          done: true,
          onSubmit,
          onCancel: () => deliverSignal("SIGINT"),
          onSessionChange,
          onQuit: quit,
          onApprovalAnswer,
          onModelSelected,
          onModelPickerCancel,
          onSetupSelect,
          onSetupKeyEntered,
          onSetupRemove,
          onSetupBack,
          onSetupClose,
          connectDispatch: undefined,
        }),
      );
      void instance.waitUntilExit().then(() => {
        resolveRunTui({
          doneReason,
          cancelledBy: undefined,
          usage,
          cost,
          refusedWithoutRunning,
          archivist,
          ranAnyTurn,
        });
      });
    };
    if (turnInFlight) {
      // MEDIUM-5: without this, cancelling a still-running turn on the way out (this whole
      // branch's own comment above) left the TUI looking frozen for however long the turn took
      // to unwind, with no indication anything had happened or that Ctrl-C was still available
      // to force it — dispatched before deliverSignal so it is visible even if the unwind never
      // completes (a stuck tool ignoring its own abort signal).
      pushTranscriptLine(dispatch, "quitting — cancelling the in-flight turn, Ctrl-C to force");
      deliverSignal("SIGINT");
      void currentTurn.then(finishQuit);
    } else {
      finishQuit();
    }
  }

  // H-1: a decision function throwing (e.g. `/undo 5` with fewer checkpoints than that) used to
  // escape straight out of Ink's own input handler — mirrors handleSlashCommand's existing
  // try/catch (the non-interactive path already has one) rather than leaving the TUI path with
  // none. M-3: input shaped like a slash command that matches nothing, or matches one but fails
  // its own accepts() guard, gets the same visible feedback instead of silently vanishing —
  // genuinely free-form text (H-3) is the only thing that becomes a new task, and only when it
  // is not shaped like a slash command at all. HIGH-1/MEDIUM-F: /exit is intercepted here, before
  // the generic SLASH_COMMANDS dispatch, since quitting is runTui's own business, not a
  // session-decision function's — it is not in that table at all (see the table's own comment).
  // MEDIUM-D: an EXACT match only, `args.length === 0`, the same discipline every SLASH_COMMANDS
  // entry's own accepts() already applies — `/exit the debugger and retry` is a task whose first
  // word happens to be /exit, not a request to quit, and used to be hijacked into one.
  // `async`, not just for `command.run`'s own sake: cycleModeCommand/rewindCommand are `async`
  // now (SlashCommand.run's own comment), and the try/catch below has to `await` the call to
  // still catch a later rejection — a bare synchronous call, unawaited, would let a failure past
  // this function's own return and surface as an unhandled rejection instead of a command-error.
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
    if (name === "/exit") {
      if (args.length > 0) {
        dispatch({ type: "command-error", message: "/exit: invalid arguments." });
        return;
      }
      quit();
      return;
    }
    // /model, like /exit just above, is intercepted here rather than added to SLASH_COMMANDS: it
    // opens a live, selectable picker, which means nothing on the non-interactive path
    // SLASH_COMMANDS also serves (handleSlashCommand has no screen to render a picker onto), so it
    // is not in that table at all (mirrors that table's own comment on why /exit isn't either).
    if (name === "/model") {
      if (args.length > 0) {
        dispatch({ type: "command-error", message: "/model: invalid arguments." });
        return;
      }
      // Bug fixed here (code-review, PR #73, same class as resolveRoute's own fix above):
      // configuredProviders reads config.json via a bare JSON.parse — a corrupted file threw
      // synchronously, and onSubmit has no caller-side .catch() (InputBox's own useInput handler
      // calls it fire-and-forget), so that became an unhandled rejection instead of a visible
      // command-error the same way every other failure in this function degrades.
      try {
        dispatch({
          type: "model-picker-requested",
          // D1/D2 (feature-plan.md): re-read fresh on every open, not cached from prepareSession —
          // a key added mid-session via /setup must show up in the very next /model open.
          entries: decideModelPickerOpen(prepared.catalog, configuredProviders(configDir)),
        });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    // /setup, like /model just above, is intercepted here rather than added to SLASH_COMMANDS: it
    // opens a live panel with nothing to render on the non-interactive path either.
    if (name === "/setup") {
      if (args.length > 0) {
        dispatch({ type: "command-error", message: "/setup: invalid arguments." });
        return;
      }
      // Same fix as /model just above: decideSetupOpen also reads config.json unguarded.
      try {
        dispatch({ type: "setup-requested", rows: decideSetupOpen(configDir) });
      } catch (err) {
        dispatch({
          type: "command-error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
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
      currentTurn = runTurn({
        ...liveState.session,
        messages: [...liveState.session.messages, { role: "user", content: trimmed }],
      });
      return;
    }
    if (!command.accepts(args)) {
      dispatch({ type: "command-error", message: `${name}: invalid arguments.` });
      return;
    }
    // MEDIUM-3: gated by the command's own mutatesRunState (SlashCommand's own comment explains
    // what it means and why /mode never sets it).
    if (turnInFlight && command.mutatesRunState === true) {
      dispatch({
        type: "command-error",
        message: `${name}: can't run while a turn is in flight.`,
      });
      return;
    }
    try {
      if (command.needsSession === false) {
        await command.run(args, dirs(ctx), tuiPresenter(dispatch, awaitNextPersist));
      } else {
        await command.run(
          liveState.session,
          args,
          dirs(ctx),
          tuiPresenter(dispatch, awaitNextPersist),
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
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const instance = render(
    createElement(App, {
      session: prepared.session,
      route: prepared.route,
      // H-3: multi-turn — the TUI never sets `done` itself here at mount. Exiting is /exit,
      // Ctrl-D (quit(), above) or Ctrl-C's job (onCancel below and signals.ts), not an implicit
      // "the last turn finished" one.
      done: false,
      onSubmit,
      // A raw Ctrl-C press is routed into the same cancel slot the readline approval prompt
      // uses (deliverSignal, cli.ts's own SIGINT-routing comment near makeApprovalPrompt).
      // While a turn is in flight, the first press aborts it via driveLoop's own
      // AbortController and returns control here — the promise above resolves, `turnInFlight`
      // clears, and the TUI is back to awaiting input, exactly per H-3. A second press within
      // that same turn — or any press while nothing is running at all, since nothing has the
      // cancel slot registered between turns (an idle first Ctrl-C is immediately fatal) —
      // finds the slot empty and falls straight through to signals.ts's own fatal path
      // (raiseSignal), matching non-TUI behavior for the same two situations rather than
      // inventing new exit semantics for either. Ink's own competing `exitOnCtrlC` default is
      // turned off below, so this is the only handler.
      onCancel: () => deliverSignal("SIGINT"),
      onSessionChange,
      onQuit: quit,
      onApprovalAnswer,
      onModelSelected,
      onModelPickerCancel,
      onSetupSelect,
      onSetupKeyEntered,
      onSetupRemove,
      onSetupBack,
      onSetupClose,
      connectDispatch: (reducerDispatch: Dispatch) => {
        reactDispatch = reducerDispatch;
        // runStart — the same three-state predicate prepareSession (above) uses to decide whether
        // it pushed the initial user message at all: "task" echoes and starts a turn on it,
        // "resume" (a bare `--continue`/`--resume`) starts a turn on the resumed session with
        // nothing to echo, and "idle" (bare `seri`, no resume, no task) starts nothing.
        const start = runStart(ctx);
        if (start === "task") echoUserInput(ctx.taskText);
        if (start !== "idle") currentTurn = runTurn(prepared.session);
      },
    }),
    // `interactive: true` — without it, Ink's own auto-detection (`ink.js`'s `resolveInteractiveOption`,
    // `interactive ?? (!isInCi && stdout.isTTY)`) weighs the `CI` env var over the real terminal:
    // whenever `CI`/`CONTINUOUS_INTEGRATION` is set (GitHub Actions sets `CI=true` on every job,
    // unconditionally, even for a job that allocated a real pty), Ink decides it is non-interactive
    // and stops live-rendering — it batches everything and "writes only the final frame at unmount"
    // per its own docs — REGARDLESS of `stdout.isTTY`. This is what made every pty test in
    // tuiPty.test.ts fail on CI's ubuntu-latest/macos-latest runners (reproduced locally by setting
    // `CI=true` in WSL2, confirmed fixed by this option, confirmed still green without it) while
    // passing 100% on WSL2, where `CI` is unset: keystrokes reached the process (confirmed with a
    // raw stdin listener bypassing Ink entirely) but nothing was ever rendered to observe. seri
    // already does its own, more accurate interactivity check before ever reaching this line —
    // `runTui` is only called when `deps.isTTY` was true (`run()`'s own `isTTY ? await runTui(...) :
    // ...`) — so overriding Ink's redundant, CI-env-var-driven second guess with that already-made
    // decision is correct here, not just a test workaround: a real user running seri interactively
    // inside any environment that happens to set `CI=true` (some devcontainers and cloud IDEs do,
    // even for a genuinely interactive session) would hit the identical silent degradation.
    { exitOnCtrlC: false, interactive: true },
  );

  // M-2: process.kill(pid, SIGINT) with no listeners left (raiseSignal, signals.ts's fatal
  // path) terminates before any more JS runs, which would otherwise leave the terminal in raw
  // mode — mirrors how the readline approval prompt already avoids this (closing the Interface
  // puts the tty back out of raw mode before a second press re-raises for real,
  // makeApprovalPrompt's own onAbort wiring). instance.unmount() is Ink's equivalent, and this
  // runs on every fatal signal death this process can have, not just the ones a turn happens to
  // be in flight for.
  onSignalCleanup(() => instance.unmount());

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
    // then persisted an empty-content message anyway — the exact bug this whole stage exists to
    // prevent, reintroduced by a whitespace-only task. One trim, at construction, means every later
    // reader of `ctx.taskText` (runStart, the push, the echo) agrees on what "empty" means.
    taskText: positionals.join(" ").trim(),
    sessionsDir: deps.sessionsDir ?? join(getConfigDir(), "sessions"),
    checkpointsDir: deps.checkpointsDir ?? join(getConfigDir(), "checkpoints"),
    permissionsDir: deps.permissionsDir ?? getConfigDir(),
    // Matches prepareSession's own resolution (D7) so /memory and the archivist read the same
    // config.json / memories/ directory a /setup-written key or a config set just landed in.
    configDir: deps.authConfigDir ?? getConfigDir(),
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

  const auth = await handleAuthCommand(positionals, deps);
  if (auth !== undefined) return auth;

  const config = handleConfigCommand(positionals, deps);
  if (config !== undefined) return config;

  const permissions = handlePermissionsCommand(positionals, deps);
  if (permissions !== undefined) return permissions;

  // Before prepareSession, never after: a bare `/undo` must act on the resume target rather than
  // mint a session to act on.
  const slash = await handleSlashCommand(ctx);
  if (slash !== undefined) return slash;

  // Open 2 (BYOK-KEY-STORAGE-AND-SETUP.md): a genuinely blank config must not hard-exit before the
  // TUI ever mounts. Gated on isTTY FIRST (code-review finding): the non-interactive path is the
  // common case and never uses this check's result, so checking isTTY before reading config.json
  // at all avoids a wasted read/parse on every piped/CI invocation — prepareSession's own
  // configuredProviders call moments later is the one that actually needs it on that path.
  //
  // No re-check after runGuidedSetup returns (thermo-nuclear finding, round 4; invariant updated by
  // byok-guided-setup-default-model): a re-check here used to `return 1` directly on a still-empty
  // config, silently — every other `return 1` in this file is preceded by a `console.error`, and
  // this bare one discarded the exact message the user needs. Falling through unconditionally
  // instead means a DECLINE (no key ever added) routes into prepareSession's own catch below, which
  // throws/prints missingKeyError's own default message ("GROQ_API_KEY is not set. Run: seri config
  // set GROQ_API_KEY <your-key>") — the SAME code path (not just the same exit code) the
  // non-interactive missing-key exit already uses. A COMPLETED guided setup is different: it now
  // persists SERI_MODEL/SERI_PROVIDER before `runGuidedSetup` returns (its own mandatory model
  // picker), so the same unconditional fall-through instead lands `prepareSession`'s
  // `resolveDefaultModel` read on that freshly-written pair rather than the groq-only fallback —
  // which is the actual fix this loop exists to ship.
  if (isTTY) {
    const zeroKeysConfigured = checkZeroKeysConfigured(ctx.configDir);
    if (typeof zeroKeysConfigured === "number") return zeroKeysConfigured;
    // getModelCatalog() deliberately NOT awaited here (code-review finding, PR #91): awaiting it
    // before runGuidedSetup blocked /setup from ever painting until the models.dev fetch settled
    // (up to FETCH_TIMEOUT_MS) — a blank terminal on exactly the flow this feature exists to make
    // instant. The fetch still starts immediately; runGuidedSetup's own onSetupClose only consumes
    // the resolved catalog once it actually needs it, by which point a real user has almost always
    // already typed a key and closed the panel.
    //
    // This IS a fetch running in parallel with a live Ink render — the exact hazard Decision 5
    // (byok-guided-setup-default-model bugfix report) originally avoided by construction, loading
    // the catalog fully BEFORE `runGuidedSetup` ever mounted. It is safe here only because Ink
    // 7.1.1's `render()` defaults `patchConsole: true` (ink/build/render.js) — `getModelCatalog`'s
    // own `printWarning` (a `console.error` call, provider/catalog.ts) gets routed above the live
    // frame instead of corrupting it, on every offline first run. A future Ink upgrade or an
    // explicit `patchConsole: false` on this `render()` call (there is none today — `runGuidedSetup`
    // only passes `exitOnCtrlC`/`interactive`) would silently reintroduce that hazard.
    if (zeroKeysConfigured) {
      await runGuidedSetup(ctx.configDir, getModelCatalog(), createSetupHandlers);
    }
  }

  const prepared = await prepareSession(ctx, deps, skipPermissions, isTTY);
  if (typeof prepared === "number") return prepared;

  const { doneReason, cancelledBy, usage, cost, refusedWithoutRunning, archivist, ranAnyTurn } =
    isTTY
      ? await runTui(prepared, ctx, deps, maxTurns, skipPermissions)
      : await driveLoop(
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
  if (!ranAnyTurn) return 0;
  if (doneReason === "no-tool-call") return refusedWithoutRunning ? 1 : 0;
  return 1;
}

if (import.meta.main) {
  // The one place a real process.stdout.isTTY is read — see CliDeps.isTTY's own comment for why
  // run() itself never reads it directly.
  run(process.argv.slice(2), { isTTY: process.stdout.isTTY }).then((code) => process.exit(code));
}
