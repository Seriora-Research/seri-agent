// The shared-state home the research spec's Constraint 4 requires: driveLoop and all four slash
// commands dispatch into this one reducer rather than each holding a separate copy. Zero Ink/React
// import — a plain, standalone reducer, testable without a terminal.
import { isQuotaExhaustedNotice } from "@seri/plans";
import type { ModelProvider } from "@seri/model-catalog";
import {
  PLAN_OVERLAY_OFF,
  type PlanOverlay,
  type PlanQuestion,
  type SubmittedPlan,
} from "../../plan/mode";
import type { AskPrompt } from "../../ask-user/types";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { toolAllowedLine } from "../../cli/output";
import type { LoopEvent } from "../../loop/loop";
import type { McpPanelRow } from "../../mcp/commands";
import type { MemoryPanelRow } from "../../memory/commands";
import type { ResolvedRoute } from "../../provider/routing";
import type { SessionState } from "../../session/session";
import {
  parseTodoList,
  TODO_TOOL_NAME,
  todoListFromMessages,
  type TodoList,
} from "../../todo/list";
import type { UsageReport } from "../../usage/report";
import type { ChromeTabId } from "../chrome/tabs";
import type { ChildEventPayload } from "../../subagents/dispatch";
import { ERROR_MARK } from "../theme/theme";
import {
  estimateTokens,
  formatDoneLine,
  formatReasoningCaret,
  type SkillsPanelRow,
  type TokenProgress,
  type TranscriptEntry,
  type TranscriptRole,
} from "../util/format";
import type { ConfigRow, ModelPickerEntry, PermissionRow, SetupProviderRow } from "./commands";
import { firstSetupActionIndex } from "./commands";
import {
  formatToolSummary,
  recordCall,
  recordDenial,
  recordResult,
  recordThrow,
  type ToolActivityEntry,
} from "./toolActivity";

// /setup's own live state — a three-step flow, mirrored on the reducer
// the same way /model's picker is: "list" shows the BYOK key rows decideSetupOpen
// computed, "enter-key" is the masked
// text-entry step (add or replace), "confirm-remove" is a single-keypress y/n. "list" carries its
// own freshly-recomputed `rows` (SetupList, App.tsx, renders and navigates them) rather than
// reaching back into a stale copy, so a step transition always renders what config.json/env
// actually say at that moment. "enter-key" and "confirm-remove" do NOT carry `rows` — neither
// SetupEnterKey nor the confirm-remove step (SetupPanel.tsx) reads a row list at all, only
// `provider`/`keyName` and their own step-specific fields; a `rows` field on either used to exist
// purely to satisfy the type, forcing cli.ts's own handlers to compute-and-thread a row array (a
// config.json read) nothing ever consumed.
export type SetupState =
  | { step: "list"; rows: SetupProviderRow[]; selected: number }
  | {
      step: "enter-key";
      provider: ModelProvider;
      keyName: string;
      error?: string;
      busy: boolean;
      note?: string;
    }
  | { step: "confirm-remove"; provider: ModelProvider; keyName: string }
  | {
      step: "confirm-connect";
      provider: "xai" | "openai" | "seri";
      action?: "connect" | "reenable";
    }
  | { step: "confirm-disconnect"; provider: "xai" | "openai" | "seri" };

export type AuthMode = "login" | "signup" | "grok" | "codex";

export type AuthPanelState =
  | { step: "starting"; mode: AuthMode }
  | { step: "device"; mode: AuthMode; verificationUri: string; userCode: string }
  | { step: "browser"; mode: AuthMode; verificationUri: string }
  | { step: "result"; message: string; error: boolean };

// /config's own live state — structurally identical to SetupState above (list -> enter-value ->
// list, list -> confirm-unset -> list), since /config edits arbitrary config.json keys the same way
// /setup edits provider API keys.
export type ConfigPanelState =
  | { step: "list"; rows: ConfigRow[]; selected: number }
  | { step: "enter-value"; key: string; error?: string; busy: boolean }
  | { step: "confirm-unset"; key: string };

// /permissions' own live state — a flat list with only a remove step, no value-entry step: there
// is nothing to type, only tools to revoke.
export type PermissionsPanelState =
  | { step: "list"; rows: PermissionRow[]; selected: number }
  | { step: "confirm-remove"; tool: string };

// /effort's own live state — the arrow-key slider over
// the legal tiers for the model this session is CURRENTLY routed to (resolveLegalReasoningTiers,
// routing.ts). Flatter than PermissionsPanelState above: one step, no confirm/remove/value-entry —
// there is nothing here but a tier to pick or cancel out of.
export type EffortPanelState = { tiers: string[]; selected: number };

export type ChromeLoad =
  | { status: "loading" }
  | { status: "logged-out" }
  | { status: "ok"; report: UsageReport; staleFrom?: string }
  | { status: "error"; message: string };

export type ChromePanelState = {
  tab: ChromeTabId;
  detail: boolean;
  load: ChromeLoad;
  generation: number;
};

// Messages typed while a turn was already running, held in submission order until drainQueue
// (cli.ts) re-submits the head. Rendered by components/QueueBlock.tsx.
//
// The id is minted by cli.ts and carried in on `queue-appended`, never generated here: this reducer
// mints nothing and reads no clock by design, which is why `turn-started` carries its timestamp in
// from cli.ts rather than calling Date.now() itself (see that action's own comment). It earns its
// place for one reason — a React key that survives a drop. Selection, editing and drop are all
// index-based and an index key would satisfy them, but the row under the mounted editor would then
// become a different element the moment a row above it went, taking the half-typed text with it.
//
// The invariant every action below re-establishes, and which normalizeQueue is the single place
// that enforces: `items.length === 0` implies `selected === 0 && editing === false`; otherwise
// `0 <= selected < items.length`.
export type QueuedMessage = { id: string; text: string };

export type MessageQueue = {
  items: QueuedMessage[];
  // Index into `items`. Pinned to 0 and meaningless while `items` is empty.
  selected: number;
  // The SELECTED item is being edited. A boolean rather than an id so "editing an item that is
  // not the selected one" cannot be represented at all.
  editing: boolean;
};

export type TuiState = {
  session: SessionState<ModelMessage>;
  // Append-only committed LOGICAL lines — one entry per `transcript-append`/pushLine call, never
  // re-split or re-joined here. The array stays complete; a mount window (spacers + slice) is a
  // render concern in TranscriptList, not a field here. OpenTUI's own Yoga layout handles
  // wrapping/scrolling, so there is no wrapped-row cache to keep in sync with it here.
  // Each entry carries a `role` ("user"/"assistant"/"system") alongside its logical text — used at
  // render time to band a user turn's rows with a background color and render an assistant answer
  // as markdown (App.tsx), without changing what gets stored.
  transcript: TranscriptEntry[];
  // The model's in-progress answer, not yet committed to the transcript and never itself rendered
  // (app.tsx's own header comment) — flushed into `transcript` the moment a non-text event needs
  // to report.
  streaming: string;
  // The live region's spinner/status line, cleared once whatever it was reporting on finishes.
  status: string;
  // Set by `turn-started` (dispatched once per turn, before the model is invoked) and cleared by
  // `turn-ended` — see that action's own comment for why it, not a bare `"error"` event, is what
  // ends a turn. `undefined` means no turn is in flight, which is what TurnStatus (app.tsx) reads to
  // decide whether to render at all. `startedAt` is a wall-clock timestamp, not a running counter —
  // see TurnStatus's own comment for why.
  turn: { startedAt: number; tokens: TokenProgress } | undefined;
  // The in-flight tool call, if any — set on every tool-call event, cleared on its
  // tool-result/permission-denied, or on an error that arrives while this slot is set (thrown
  // execute: tool-call then error, no tool-result). Single-slot: the loop still yields one
  // call/result pair at a time even when consecutive read-only executes overlap, so the next
  // result's args are always this pending call's. A dedicated field
  // rather than App.tsx string-matching `status`'s rendered text (`"Running write_file…"`)
  // against the last transcript line, which only worked by coincidence and would silently stop
  // working the moment either string changed.
  pendingTool: { name: string; args: unknown } | undefined;
  // Per-tool-name stats for the current turn, living outside `transcript`. Updated on every
  // tool-call/tool-result/permission-denied, and on an error that arrives while a call is in
  // flight (recordThrow). App live-paints the settled view of this
  // accumulator during the turn (renderLiveToolActivity). On done / turn-ended the tree
  // is dropped and at most one muted count line is kept ("Read 1 file, ran 2 shell
  // commands"). An error LoopEvent is not turn-end (loop.ts continues), so this
  // accumulator is left in place across it — live paint still shows it. After a real
  // done, turn-ended's clear is a no-op on [].
  toolActivity: ToolActivityEntry[];
  // A slash command that threw (previously uncaught, straight through Ink's own input handler),
  // or input shaped like a slash command that matched nothing / failed its own accepts() guard —
  // rendered with theme.ts's `error` role rather than left to vanish silently. Cleared by
  // `command-error-cleared`, dispatched alongside every submission's own echo (echoUserInput,
  // cli.ts) — so it clears on the very next submission, success or failure of that submission.
  commandError: string | undefined;
  // The TUI-native ApprovalPrompt's own live state — set when runTui's tuiApprovalPrompt is
  // called (a write-tool call reached the
  // gate), cleared once the user answers. `offersAlways` mirrors makeApprovalPrompt's own
  // PERSISTABLE_TOOLS check, computed once at request time rather than re-derived at render time.
  // App.tsx renders its own ApprovalBox instead of InputBox whenever this is set — mutually
  // exclusive, matching how the non-interactive CLI already blocks on this same question before
  // reading anything else from stdin.
  pendingApproval:
    | {
        toolName: string;
        args: unknown;
        offersAlways: boolean;
        classifierReason?: string;
      }
    | undefined;
  // Occupancy snapshot for ask_user. The park in cli.ts owns the resolve; this field is what
  // App.tsx paints. Not parked on `plan.kind`. The reducer can hold this next to
  // `pendingApproval` (ApprovalBox still wins the ternary), but no production path sets
  // both: `runLoop` runs `ask_user` only on the sequential branch after `flushReadBatch`.
  pendingAskUser: AskPrompt | undefined;
  // /model's own live state, mirroring pendingApproval's shape exactly: set when the picker opens
  // (decideModelPickerOpen's own result, tui/commands.ts), cleared once resolved. App.tsx renders
  // its own ModelPicker instead of InputBox whenever this is set — the same three-way mutual
  // exclusion pendingApproval already establishes for ApprovalBox, extended to a third state
  // rather than a second independent flag. `pendingApproval` and `pendingModelPicker` CAN both be
  // set at once, despite that: cli.ts's onSubmit handles /model before the turnInFlight guard that
  // gates ordinary tasks and mutatesRunState commands, so a user can open the picker while a turn
  // — and the approval prompt it may have triggered — is still in flight. App.tsx's own render
  // ternary picks ApprovalBox first in that case, so the picker stays open (this field stays set)
  // but hidden behind the approval prompt until that resolves, rather than the two ever competing
  // for the screen at once. Whether that is the right UX for a mid-turn /model is not decided by
  // this comment; it is only what the current render order actually does.
  pendingModelPicker: { entries: ModelPickerEntry[] } | undefined;
  // A single pty chunk carrying filter text, a terminator, AND further characters (measured as
  // real on a real terminal, the same class InputBox's own paste-terminator handling addresses)
  // used to just discard everything after the terminator when it closed the picker — dropped
  // keystrokes with the picker gone and no trace of what was typed. Set by
  // `model-picker-resolved`'s `leftoverInput`, consumed once by InputBox as its own starting
  // value on the very next mount, then cleared — never re-applied to a later, unrelated mount.
  pendingInputPrefill: string | undefined;
  // /setup's own live state — mirrors `pendingModelPicker`'s shape and mutual-exclusion role
  // exactly, extended to a fourth render-ternary branch (App.tsx). Can coexist with
  // `pendingApproval`/`pendingModelPicker` the same way those two already can with each other,
  // for the identical reason: cli.ts's onSubmit handles /setup before the turnInFlight guard.
  pendingSetup: SetupState | undefined;
  // Whether the welcome splash should offer Log in / Sign up (true) or just Continue (false).
  // Independent of `pendingAuth` — that flag is the blocking auth panel, this one only
  // chooses the splash menu. Set by `auth-offer` (decideAuthOffer). The main TUI does not
  // render a sign-in banner from this flag.
  authOffer: boolean;
  // /login and /signup's own blocking panel. Mirrors `pendingSetup`'s mutual-exclusion role in the
  // render ternary.
  pendingAuth: AuthPanelState | undefined;
  // /config's own blocking panel. Mirrors `pendingSetup`'s role.
  pendingConfig: ConfigPanelState | undefined;
  // /permissions' own blocking panel. Mirrors `pendingSetup`'s role.
  pendingPermissions: PermissionsPanelState | undefined;
  // /skills' own blocking panel. Mirrors `pendingSetup`'s role. Holds the rows resolved from the
  // session's registry at the moment the panel opened, not the registry itself: the panel is a view
  // of what this session actually loaded, and re-reading disk while it is open would show rows the
  // running session cannot invoke.
  pendingSkills: { rows: SkillsPanelRow[] } | undefined;
  // /mcp's own blocking panel, mirroring pendingSkills exactly — same rationale: rows resolved
  // from the session's registry and client pool at the moment the panel opened, never re-read from
  // a live connect/trust that happened while it was open, so a reconnect or trust decision is
  // applied by re-dispatching mcp-requested with freshly recomputed rows, not by this reducer
  // reaching back into disk on its own.
  pendingMcp: { rows: readonly McpPanelRow[] } | undefined;
  // /memory's own blocking panel, mirroring pendingSkills/pendingMcp. Rows are read from the staged
  // queue on disk at the moment the panel opens, not from a session-frozen registry: unlike a skill,
  // a memory write staged by the turn that just ran is reviewable right now. An approve or reject
  // taken inside the panel re-dispatches `memory-requested` with freshly read rows, the same way a
  // panel-driven /mcp removal does, rather than this reducer reaching for disk itself.
  pendingMemory: { rows: readonly MemoryPanelRow[] } | undefined;
  // /effort's own blocking panel. Mirrors `pendingSetup`'s role — set when
  // the bare, no-argument form opens the slider (runTui's own onSubmit interception, cli.ts),
  // cleared once resolved.
  pendingEffort: EffortPanelState | undefined;
  pendingChrome: ChromePanelState | undefined;
  plan: PlanOverlay;
  // The welcome-splash mount's own blocking panel. Seeded by `initialTuiState`'s `showSplash` opt,
  // which App forwards from its `showSplash` prop so the first committed frame is already the
  // splash. `splash-requested` (runWelcomeSplash's connectDispatch) still sets it true after mount,
  // but that effect cannot win the first paint — it runs after the first commit. `runTui` and
  // `runGuidedSetup` omit the prop, so their App instances never render WelcomeSplash for the same
  // launch.
  pendingSplash: boolean;
  // Latched by `splash-resolved`, never cleared. `pendingSplash` alone cannot tell "before the
  // splash" from "after it": both are `false`. The pre-session input box (app.tsx) keys off this
  // so it cannot appear until the login choice is answered. A mount that forgets `showSplash`
  // still lands its first frame in the before-splash state; this latch is what keeps that frame
  // from offering a live input box.
  splashDone: boolean;
  // The status bar's own model+route label reads this, not `AppProps.route` (App.tsx's own
  // comment on that prop) — the prop only seeds this field at mount; every later switch reaches
  // the label by dispatching `route-updated` instead, the same "reducer state, not a caller-held
  // copy" shape `session` above already uses. Optional for the identical reason `AppProps.route`
  // is: runGuidedSetup mounts App before any provider key/route exists yet.
  route: ResolvedRoute | undefined;
  // See `"config-updated"`'s own comment, below, for what this is and why.
  config: Record<string, string>;
  // See MessageQueue's own comment, above. Not part of the session and never persisted: a queued
  // message has not been said to the model yet, and a session resumed with one still pending
  // would replay it with no way for the user to see it coming.
  queue: MessageQueue;
  checklist: TodoList;
  // In-memory live rows for the in-flight dispatch. Cleared when the parent
  // dispatch_subagents tool-result lands (the summaries are already in the parent
  // context), on transcript-cleared (`/clear`), and on turn-started. Not session JSON.
  subagents: ChildView[];
  subagentPanelFocus: boolean;
  // Marker only: `"main"` or a child id. `pendingChildView` is whose transcript fills
  // the scrollbox (`undefined` = parent). Arrows never change `pendingChildView`.
  subagentPanelSelectedId: string | undefined;
  pendingChildView: string | undefined;
  // In-flight thought span for the parent chat only. Settled rows live on
  // `transcript` (`kind: "reasoning"`). Not session JSON.
  reasoning: ReasoningState;
};

export type ReasoningState = {
  expanded: boolean;
  live?: { text: string; startedAt: number };
};

export type ChildView = {
  id: string;
  role: ChildEventPayload["role"];
  goal: string;
  status: "running" | "done" | "error" | "aborted";
  currentTool?: { name: string; args: unknown };
  transcript: TranscriptEntry[];
  streaming: string;
  toolActivity: ToolActivityEntry[];
  model?: string;
  provider?: ModelProvider;
  inherited?: boolean;
};

// What "an empty transcript" means, as a single value rather than fields independently kept
// in sync at two call sites (initialTuiState below, and the `transcript-cleared` case's own
// comment on why every one of them must move together): a future field added to this set only
// needs updating here once. `Readonly<Pick<TuiState, ...>>` (rather than a cast) means a field
// removed from TuiState is a compile error here too, not just a silent orphan. Both the object and
// its `transcript` array are frozen: every TuiState this is spread into shares the SAME array
// instance, so an in-place mutation of one state's `transcript` (nothing does this today, but
// nothing stops it either) would otherwise corrupt every other state — including a concurrent test
// — that spread from this same constant.
const EMPTY_REASONING: ReasoningState = Object.freeze({ expanded: false });

const EMPTY_TRANSCRIPT: Readonly<
  Pick<TuiState, "transcript" | "streaming" | "toolActivity" | "reasoning">
> = Object.freeze({
  // `as TranscriptEntry[]`: TuiState.transcript is declared mutable (App.tsx replaces it wholesale
  // rather than pushing in place), and TS's array variance treats `readonly T[]` and `T[]` as
  // genuinely different types — frozen at runtime regardless of this cast, which only restores the
  // static type this field is spread into everywhere else.
  transcript: Object.freeze([] as TranscriptEntry[]) as TranscriptEntry[],
  streaming: "",
  toolActivity: Object.freeze([] as ToolActivityEntry[]) as ToolActivityEntry[],
  reasoning: EMPTY_REASONING,
});

const EMPTY_ROSTER: Readonly<
  Pick<
    TuiState,
    "subagents" | "subagentPanelFocus" | "subagentPanelSelectedId" | "pendingChildView"
  >
> = Object.freeze({
  subagents: Object.freeze([] as ChildView[]) as ChildView[],
  subagentPanelFocus: false,
  subagentPanelSelectedId: undefined,
  pendingChildView: undefined,
});

// What "an empty queue" means, in one place — `initialTuiState` and every action that removes the
// last item all reach the identical value, so none of them can drift into a shape
// the MessageQueue invariant forbids. Frozen for the same reason EMPTY_TRANSCRIPT above is: every
// state spread from this shares the SAME `items` instance.
const EMPTY_QUEUE: MessageQueue = Object.freeze({
  // `as string[]`: same cast, same reason as EMPTY_TRANSCRIPT's own — the field is declared
  // mutable, and TS treats `readonly T[]` as a genuinely different type.
  items: Object.freeze([] as QueuedMessage[]) as QueuedMessage[],
  selected: 0,
  editing: false,
});

// The single place MessageQueue's invariant is established. Every queue action routes its result
// through here rather than clamping for itself, so "an empty list pins selection to 0 and cannot
// be editing" is one statement instead of eight that have to agree.
function normalizeQueue(items: QueuedMessage[], selected: number, editing: boolean): MessageQueue {
  if (items.length === 0) return EMPTY_QUEUE;
  return { items, selected: Math.min(Math.max(selected, 0), items.length - 1), editing };
}

export function initialTuiState(
  session: SessionState<ModelMessage>,
  opts?: {
    showSplash?: boolean;
    authOffer?: boolean;
    route?: ResolvedRoute;
    config?: Record<string, string>;
  },
): TuiState {
  return {
    session,
    route: opts?.route,
    config: opts?.config ?? {},
    queue: EMPTY_QUEUE,
    checklist: todoListFromMessages(session.messages),
    ...EMPTY_TRANSCRIPT,
    status: "",
    turn: undefined,
    pendingTool: undefined,
    commandError: undefined,
    pendingApproval: undefined,
    pendingAskUser: undefined,
    pendingModelPicker: undefined,
    pendingInputPrefill: undefined,
    pendingSetup: undefined,
    authOffer: opts?.authOffer ?? false,
    pendingAuth: undefined,
    pendingConfig: undefined,
    pendingPermissions: undefined,
    pendingSkills: undefined,
    pendingMcp: undefined,
    pendingMemory: undefined,
    pendingEffort: undefined,
    pendingChrome: undefined,
    plan: PLAN_OVERLAY_OFF,
    pendingSplash: opts?.showSplash ?? false,
    splashDone: false,
    ...EMPTY_ROSTER,
  };
}

export type TuiAction =
  | { type: "session-updated"; session: SessionState<ModelMessage> }
  // The user row a turn is about to be run against, dispatched by runTurn (cli.ts) before the model
  // is called. Merges exactly as `messages-updated` does, and is a separate action rather than a
  // synthetic one of those because that event means "the provider answered this turn" to its other
  // consumers — runTurn's own `onEvent` persists the default model pair and reasoning tier on it,
  // which for an unanswered turn would pin a model that never worked.
  | { type: "user-turn-committed"; messages: ModelMessage[] }
  // `flush` defaults to true (every existing caller relies on that) — set to false by a submission
  // echo that must not fragment an in-progress streamed answer into two transcript entries (see
  // pushLine's own comment).
  | {
      type: "transcript-append";
      line: string;
      role?: TranscriptRole;
      flush?: boolean;
      muted?: boolean;
      markdown?: boolean;
    }
  // /clear's own action. The only action that ever SHRINKS the transcript, rather than adding to
  // it — `streaming` must be reset alongside `transcript` itself, or a stale in-progress answer
  // would keep describing content that no longer exists.
  | { type: "transcript-cleared" }
  | { type: "loop-event"; event: LoopEvent }
  | { type: "command-error"; message: string }
  | { type: "command-error-cleared" }
  | {
      type: "approval-requested";
      toolName: string;
      args: unknown;
      offersAlways: boolean;
      classifierReason?: string;
    }
  | { type: "approval-resolved" }
  | { type: "ask-user-requested"; prompt: AskPrompt }
  | { type: "ask-user-resolved" }
  | { type: "plan-on" }
  | { type: "plan-off" }
  | { type: "plan-questions-requested"; questions: readonly PlanQuestion[] }
  | { type: "plan-review-requested"; plan: SubmittedPlan }
  | { type: "model-picker-requested"; entries: ModelPickerEntry[] }
  // `pick`, when present, is the SAME atomic transition as clearing pendingModelPicker — not a
  // second dispatch — so there is never a one-frame render where the session already switched
  // models but the picker is still showing, or the picker is gone but the switch hasn't landed.
  // Carries only the pick itself (model + provider), not a whole captured SessionState: this used
  // to carry a full session snapshot taken from `state.session` at the moment ModelPicker rendered
  // (App.tsx's own `session` prop), which a `messages-updated` landing in between picker-open and
  // picker-resolve (a real race — the picker can open mid-turn, see pendingModelPicker's own
  // comment) would make stale — resolving the picker then overwrote the reducer's own, newer
  // `state.session.messages` with whatever the picker had captured minutes earlier. Merging just
  // the pick into the reducer's OWN CURRENT session (below) instead of replacing it wholesale is
  // what closes that race, the same "read the reducer's own state, not a caller's stale copy"
  // fix already applied to `messages-updated` itself (see that case's own comment).
  | {
      type: "model-picker-resolved";
      // `keyConfigured` (ModelPickerEntry's own field, threaded through from the picker row —
      // ModelPicker.tsx) is what tells the optimistic `route` update below whether it may claim
      // "your key": it does NOT determine which provider a reroute/gateway hop would land on
      // (that's `resolveRoute`'s job, which needs the catalog/configured-providers/plan this
      // reducer doesn't have), only whether one is needed at all.
      pick?: { model: string; provider: ModelProvider; keyConfigured: boolean };
      // The dispatcher's own resolveSessionRoute result for `pick` (cli.ts's onModelSelected).
      // Guided setup (routes/setup/guidedSetup.ts) has no catalog or plan yet and omits it.
      route?: ResolvedRoute;
      // Text typed after a combined-chunk terminator (see `pendingInputPrefill`'s own comment) —
      // present only on the rare chunked-input path, absent on every ordinary Enter.
      leftoverInput?: string;
    }
  // A one-shot signal: InputBox has read `pendingInputPrefill` as its starting value and it must
  // not be handed to any later, unrelated mount. Dispatched by InputBox itself, once, on mount.
  | { type: "input-prefill-consumed" }
  // /setup's own three actions, mirroring the /model pair above. `setup-requested` always opens on
  // "list" (decideSetupOpen's own result) — there is no equivalent to a mid-turn open landing on a
  // different step, since /setup is user-initiated every time, never re-entered from elsewhere.
  | { type: "setup-requested"; rows: SetupProviderRow[] }
  // A single action for every step transition (list -> enter-key -> list, list -> confirm-remove
  // -> list, an error re-rendering the SAME step, …) rather than one action per transition: every
  // handler in cli.ts already computes the FULL next SetupState itself (recomputing `rows` fresh
  // each time — decideSetupOpen's own contract), so the reducer has nothing left to decide here,
  // the same "this is presentation-adjacent plumbing, not a decision" reasoning `session-updated`
  // already applies to a whole SessionState.
  | { type: "setup-step"; state: SetupState }
  // Mirrors `model-picker-resolved`'s own `leftoverInput` handling exactly — /setup's panel can
  // also close mid-chunk on a real pty.
  | { type: "setup-resolved"; leftoverInput?: string }
  // `pendingAuth`/`pendingConfig`/`pendingPermissions`'s own step transitions land on these ten.
  // `auth-offer` chooses the splash menu (unsigned-in vs already signed in) — deliberately NOT
  // `pendingAuth`, which is the blocking auth panel (see TuiState's own comment).
  | { type: "auth-offer"; show: boolean }
  | { type: "auth-requested"; mode: AuthMode }
  | { type: "auth-step"; state: AuthPanelState }
  | { type: "auth-resolved"; leftoverInput?: string }
  | { type: "config-requested"; rows: ConfigRow[] }
  | { type: "config-step"; state: ConfigPanelState }
  | { type: "config-resolved"; leftoverInput?: string }
  | { type: "permissions-requested"; rows: PermissionRow[] }
  | { type: "permissions-step"; state: PermissionsPanelState }
  | { type: "permissions-resolved"; leftoverInput?: string }
  // /effort's own two actions, mirroring the /model pair
  // (model-picker-requested/model-picker-resolved) rather than /setup's five-action step-dispatcher
  // shape: there is only one step here, so one open action and one resolve action is the whole
  // surface. `effort-resolved`'s `tier`, when present, is merged directly into `state.session` in
  // the SAME atomic transition as clearing `pendingEffort` — the identical race `model-picker-
  // resolved`'s own comment explains avoiding (a `messages-updated` landing between open and
  // resolve must not be clobbered by a second, separate dispatch).
  // /skills' own pair, the same one-open-one-close shape /effort uses: one step, nothing to
  // navigate between.
  | { type: "skills-requested"; rows: SkillsPanelRow[] }
  | { type: "skills-closed" }
  // /mcp's own pair, mirroring skills-requested/skills-closed exactly.
  | { type: "mcp-requested"; rows: readonly McpPanelRow[] }
  | { type: "mcp-closed" }
  // /memory's own pair, mirroring mcp-requested/mcp-closed exactly.
  | { type: "memory-requested"; rows: readonly MemoryPanelRow[] }
  | { type: "memory-closed" }
  | { type: "effort-requested"; tiers: string[]; selected: number }
  | { type: "chrome-requested"; tab: ChromeTabId; detail: boolean }
  | { type: "chrome-loaded"; generation: number; load: ChromeLoad }
  | { type: "chrome-tab"; tab: ChromeTabId }
  | { type: "chrome-closed"; leftoverInput?: string }
  | { type: "effort-resolved"; tier?: string; leftoverInput?: string }
  | { type: "splash-requested" }
  | { type: "splash-resolved" }
  // Dispatched by runTurn (cli.ts) right after its own per-turn `resolveRoute` call succeeds —
  // the fix for issue #132: the status bar's label used to be frozen at mount (App.tsx's own
  // `route` prop, never re-read after the initial render), so a /model switch's own freshly
  // resolved route never reached it. `state.route` is what the label now reads.
  | { type: "route-updated"; route: ResolvedRoute }
  // Dispatched with the freshly re-read config.json record by every writer of it: runTurn (cli.ts)
  // alongside `route-updated` every turn, /config's own save/unset handlers (handlers.ts) the
  // moment a key is written or removed, and the per-turn `SERI_REASONING_EFFORT` persist-on-
  // success gate (cli.ts) right after it writes. One unconditional action carrying the whole
  // record, rather than a bespoke dispatch per config-derived display value: `state.config` is
  // what the header's own `effortTier` (app.tsx) reads `SERI_REASONING_EFFORT` out of via
  // `loadReasoningEffortConfig` when `session.reasoningEffort` is `undefined`, and a future
  // config-derived field reads the same `state.config` rather than needing its own action.
  | { type: "config-updated"; config: Record<string, string> }
  // Dispatched by runTurn (cli.ts) right alongside `route-updated`, before driveLoop starts —
  // the one place in runTurn that already fires once per turn, before the model is invoked. Starts
  // TurnStatus's elapsed clock and resets the turn's token progress fresh, so a second turn never
  // inherits the first turn's token count for even one frame. Carries its own `startedAt` (cli.ts's
  // own `Date.now()`, read at dispatch time) rather than the reducer calling `Date.now()` itself —
  // this file's own header comment advertises a pure, terminal-independent reducer, and generating
  // a timestamp internally would be the one place that broke it. `inputEstimate` (cli.ts's own
  // `estimateTokens` call on the current turn's newly-submitted user text, or 0 when there is none —
  // a slash-command-triggered/resumed turn with no new typed text) seeds `tokens.liveInputEstimate`
  // for the same reason: the reducer stays pure, never re-deriving the estimate itself.
  | { type: "turn-started"; startedAt: number; inputEstimate: number }
  // Dispatched by runTurn (cli.ts) once its own `driveLoop` call has actually settled — success or
  // failure — the one place that reliably knows the turn is truly over, and the SOLE action that
  // clears `state.turn` (TuiState's own comment on that field). NOT dispatched from a bare
  // `"error"` `LoopEvent`: loop.ts yields `"error"` from several non-terminal sites (a failed
  // compaction, an unknown tool call, a tool that threw) that all keep the turn running afterward,
  // and clearing TurnStatus's own state on any of those made a turn that was still very much in
  // progress look like it had silently died.
  | { type: "turn-ended" }
  // streamDispatch drains buffered thought text with the wall-clock of the first
  // delta, not the drain tick — otherwise a think that lasted seconds would settle
  // as `0s` because start and end would share one Date.now().
  | { type: "reasoning-flushed"; text: string; startedAt: number }
  | { type: "reasoning-toggled" }
  // The message queue's own eight actions (MessageQueue, above). Three of them — selection-moved,
  // edit-started, item-dropped — deliberately no-op while `editing`, which is a correctness fix
  // rather than politeness: without the first of those, two items queued, Ctrl+E on row 1 and then
  // Ctrl+↓ moves `selected` to row 2, and the Enter that commits row 1's edited text writes it into
  // row 2 instead, because `queue-edit-committed` targets whatever `selected` is at commit time.
  // Each case below states its own version of that.
  //
  // `text` is carried untrimmed on both `queue-appended` and `queue-edit-committed`: cli.ts trims
  // only to DECIDE (is this blank, does it start a turn), never to store, so what eventually
  // reaches the model is the text the user actually typed.
  | { type: "queue-appended"; id: string; text: string }
  | { type: "queue-selection-moved"; delta: number }
  | { type: "queue-edit-started" }
  | { type: "queue-edit-committed"; text: string }
  | { type: "queue-edit-cancelled" }
  | { type: "queue-item-dropped" }
  | { type: "queue-head-taken" }
  | ({ type: "subagent-child-event" } & ChildEventPayload)
  | { type: "subagent-panel-focus" }
  | { type: "subagent-panel-blur" }
  | { type: "subagent-panel-select"; id: string }
  | { type: "subagent-overlay-open"; id: string }
  | { type: "subagent-overlay-close" };

// A shorthand for "given this action, do something with it": App.tsx's own `connectDispatch`
// prop (the stream-coalesced dispatch handed back to cli.ts's runTui), runTui's own
// `dispatch` handle built from it, and tuiPresenter (cli.ts), which dispatches into it rather
// than printing. driveLoop itself takes a plain `onEvent: (event: LoopEvent) => void` now, not
// this — it only ever dispatched one action shape, so it no longer needs to know TuiAction
// exists at all. Lives here, not cli.ts, since it is built from TuiAction, declared right above.
export type Dispatch = (action: TuiAction) => void;

function emptyChild(
  id: string,
  role: ChildEventPayload["role"],
  goal: string,
  route?: Pick<ChildEventPayload, "model" | "provider" | "inherited">,
): ChildView {
  return {
    id,
    role,
    goal,
    status: "running",
    transcript: [],
    streaming: "",
    toolActivity: [],
    model: route?.model,
    provider: route?.provider,
    inherited: route?.inherited,
  };
}

function flushChildStreaming(child: ChildView): ChildView {
  if (child.streaming.length === 0) return child;
  return {
    ...child,
    transcript: [...child.transcript, { role: "assistant", text: child.streaming }],
    streaming: "",
  };
}

function applyChildLoopEvent(child: ChildView, event: ChildEventPayload["event"]): ChildView {
  switch (event.type) {
    case "child-started":
      return child;
    case "text-delta":
      return { ...child, streaming: child.streaming + event.text };
    case "reasoning-delta":
      return child;
    case "tool-call": {
      const flushed = flushChildStreaming(child);
      return {
        ...flushed,
        currentTool: { name: event.name, args: event.args },
        toolActivity: recordCall(flushed.toolActivity, event.name, event.args),
      };
    }
    case "tool-result":
      return {
        ...child,
        toolActivity: recordResult(
          child.toolActivity,
          event.name,
          child.currentTool?.args,
          event.result,
        ),
        // Same slot as the parent's pendingTool: an error while this is set is treated as
        // that call throwing. A settled call has to drop it or a later hook error paints
        // as a false throw on a tool that already succeeded.
        currentTool: undefined,
      };
    case "permission-denied":
      return {
        ...child,
        toolActivity: recordDenial(child.toolActivity, event.name, event.reason),
        currentTool: undefined,
      };
    case "error": {
      // Thrown execute is tool-call then error, no tool-result — same as the parent reducer.
      // Attach the failure to the open group and drop currentTool so the live "current" line
      // does not keep painting a call that has already settled as an anomaly.
      const pending = child.currentTool;
      if (pending !== undefined) {
        return {
          ...child,
          toolActivity: recordThrow(child.toolActivity, pending.name, pending.args, event.error),
          currentTool: undefined,
          status: "error",
        };
      }
      return { ...child, status: "error" };
    }
    case "done":
      return {
        ...flushChildStreaming(child),
        status: event.reason === "aborted" ? "aborted" : "done",
      };
    case "usage":
    case "compacted":
    case "messages-updated":
    case "retry":
    case "tool-allowed":
      return child;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function applyChildEvent(
  state: TuiState,
  action: { type: "subagent-child-event" } & ChildEventPayload,
): TuiState {
  if (action.event.type === "child-started") {
    if (state.subagents.some((child) => child.id === action.childId)) return state;
    return {
      ...state,
      subagents: [...state.subagents, emptyChild(action.childId, action.role, action.goal, action)],
    };
  }
  if (action.event.type === "usage" || action.event.type === "compacted") {
    // Billed child spend belongs on the parent turn total (TurnStatus / done line). Do not push
    // a compacted transcript line — that line is the parent's own compaction, not the child's.
    if (state.turn === undefined) return state;
    return {
      ...state,
      turn: {
        ...state.turn,
        tokens: reconcileUsage(state.turn.tokens, action.event.usage),
      },
    };
  }
  if (!state.subagents.some((child) => child.id === action.childId)) return state;
  return {
    ...state,
    subagents: state.subagents.map((child) =>
      child.id === action.childId ? applyChildLoopEvent(child, action.event) : child,
    ),
  };
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "session-updated":
      return {
        ...state,
        session: action.session,
        checklist: todoListFromMessages(action.session.messages),
      };
    case "user-turn-committed":
      return {
        ...state,
        session: { ...state.session, messages: action.messages },
        checklist: todoListFromMessages(action.messages),
      };
    // pushLine, not a bare append: this used to be harmless when transcript-append had no real
    // callers, but tuiPresenter.message, undoPlanLines/recoveryLines and quit()'s own "quitting -
    // cancelling..." line all go through this case now, and the last of those fires specifically
    // WHILE a turn may still be streaming text — without flushing here first, a /mode or /exit
    // typed mid-stream reordered the transcript against the model's own still-in-progress answer.
    case "transcript-append":
      return pushLine(
        state,
        action.line,
        action.role ?? "system",
        action.flush ?? true,
        action.muted ?? false,
        action.markdown ?? false,
      );
    case "transcript-cleared":
      return {
        ...state,
        ...EMPTY_TRANSCRIPT,
        ...EMPTY_ROSTER,
        plan: PLAN_OVERLAY_OFF,
        checklist: [],
      };
    case "loop-event":
      return applyLoopEvent(state, action.event);
    case "command-error":
      return { ...state, commandError: action.message };
    case "command-error-cleared":
      return { ...state, commandError: undefined };
    case "approval-requested":
      return {
        ...state,
        pendingApproval: {
          toolName: action.toolName,
          args: action.args,
          offersAlways: action.offersAlways,
          ...(action.classifierReason !== undefined
            ? { classifierReason: action.classifierReason }
            : {}),
        },
      };
    case "approval-resolved":
      return { ...state, pendingApproval: undefined };
    case "ask-user-requested":
      return {
        ...state,
        pendingAskUser: action.prompt,
        subagentPanelFocus: false,
        pendingChildView: undefined,
      };
    case "ask-user-resolved":
      return { ...state, pendingAskUser: undefined };
    case "plan-on":
      return { ...state, plan: { kind: "on" } };
    case "plan-off":
      return { ...state, plan: PLAN_OVERLAY_OFF };
    case "plan-questions-requested":
      return { ...state, plan: { kind: "clarifying", questions: action.questions } };
    case "plan-review-requested":
      return { ...state, plan: { kind: "reviewing", ...action.plan } };
    case "model-picker-requested":
      return { ...state, pendingModelPicker: { entries: action.entries } };
    case "model-picker-resolved":
      // Merged into `state.session` (this reducer's own current session), not a caller-captured
      // one — see TuiAction's own comment on `pick`.
      //
      // `route` moves here too, not just `session`: the mode row and session banner read
      // `state.route`, and the next `route-updated` dispatch (cli.ts's runTurn) is a whole turn
      // away. Without `action.route` this reducer can only name a route for a pick whose own
      // provider has a key (Rule 1 of `resolveRoute`, routing.ts — never rerouted); for a no-key
      // pick it cannot know where the reroute or gateway hop lands, and claiming `credential:
      // "key"` would render "your key" for a key the user lacks, so `state.route` stays as-is.
      if (action.pick === undefined) {
        return {
          ...state,
          pendingModelPicker: undefined,
          pendingInputPrefill: action.leftoverInput,
        };
      }
      return {
        ...state,
        pendingModelPicker: undefined,
        pendingInputPrefill: action.leftoverInput,
        session: {
          ...state.session,
          model: action.pick.model,
          provider: action.pick.provider,
        },
        route:
          action.route ??
          (action.pick.keyConfigured
            ? {
                model: action.pick.model,
                provider: action.pick.provider,
                rerouted: false,
                credential: "key",
              }
            : state.route),
      };
    case "input-prefill-consumed":
      return { ...state, pendingInputPrefill: undefined };
    case "setup-requested":
      return {
        ...state,
        pendingSetup: {
          step: "list",
          rows: action.rows,
          selected: firstSetupActionIndex(action.rows),
        },
      };
    case "setup-step":
      return { ...state, pendingSetup: action.state };
    case "setup-resolved":
      return { ...state, pendingSetup: undefined, pendingInputPrefill: action.leftoverInput };
    case "auth-offer":
      return { ...state, authOffer: action.show };
    case "auth-requested":
      return { ...state, pendingAuth: { step: "starting", mode: action.mode } };
    case "auth-step":
      return { ...state, pendingAuth: action.state };
    case "auth-resolved":
      return { ...state, pendingAuth: undefined, pendingInputPrefill: action.leftoverInput };
    case "config-requested":
      return { ...state, pendingConfig: { step: "list", rows: action.rows, selected: 0 } };
    case "config-step":
      return { ...state, pendingConfig: action.state };
    case "config-resolved":
      return { ...state, pendingConfig: undefined, pendingInputPrefill: action.leftoverInput };
    case "permissions-requested":
      return {
        ...state,
        pendingPermissions: { step: "list", rows: action.rows, selected: 0 },
      };
    case "permissions-step":
      return { ...state, pendingPermissions: action.state };
    case "permissions-resolved":
      return {
        ...state,
        pendingPermissions: undefined,
        pendingInputPrefill: action.leftoverInput,
      };
    case "skills-requested":
      return { ...state, pendingSkills: { rows: action.rows } };
    case "skills-closed":
      return { ...state, pendingSkills: undefined };
    case "mcp-requested":
      return { ...state, pendingMcp: { rows: action.rows } };
    case "mcp-closed":
      return { ...state, pendingMcp: undefined };
    case "memory-requested":
      return { ...state, pendingMemory: { rows: action.rows } };
    case "memory-closed":
      return { ...state, pendingMemory: undefined };
    case "effort-requested":
      return { ...state, pendingEffort: { tiers: action.tiers, selected: action.selected } };
    case "chrome-requested": {
      const generation = (state.pendingChrome?.generation ?? 0) + 1;
      return {
        ...state,
        pendingChrome: {
          tab: action.tab,
          detail: action.detail,
          load: { status: "loading" },
          generation,
        },
      };
    }
    case "chrome-loaded":
      if (
        state.pendingChrome === undefined ||
        state.pendingChrome.generation !== action.generation
      ) {
        return state;
      }
      return { ...state, pendingChrome: { ...state.pendingChrome, load: action.load } };
    case "chrome-tab":
      if (state.pendingChrome === undefined) return state;
      return { ...state, pendingChrome: { ...state.pendingChrome, tab: action.tab } };
    case "chrome-closed":
      return { ...state, pendingChrome: undefined, pendingInputPrefill: action.leftoverInput };
    case "effort-resolved":
      // Merged into `state.session` (this reducer's own current session), not a caller-captured
      // one — same reasoning as `model-picker-resolved`'s own comment (TuiAction, above).
      // `tier === undefined` (Escape/Ctrl-D — no pick made) leaves `state.session` untouched.
      return {
        ...state,
        pendingEffort: undefined,
        pendingInputPrefill: action.leftoverInput,
        session:
          action.tier === undefined
            ? state.session
            : { ...state.session, reasoningEffort: action.tier },
      };
    case "splash-requested":
      return { ...state, pendingSplash: true };
    case "splash-resolved":
      return { ...state, pendingSplash: false, splashDone: true };
    case "route-updated":
      return { ...state, route: action.route };
    case "config-updated":
      return { ...state, config: action.config };
    case "turn-started":
      return {
        ...state,
        ...EMPTY_ROSTER,
        reasoning: EMPTY_REASONING,
        turn: {
          startedAt: action.startedAt,
          tokens: {
            reconciledInputTokens: 0,
            reconciledOutputTokens: 0,
            liveInputEstimate: action.inputEstimate,
            carriedOutputEstimate: 0,
            liveOutputEstimate: 0,
            exact: false,
            hasGap: false,
          },
        },
      };
    case "turn-ended":
      // Commit a leftover thought and any parked assistant text (loop.ts can error-then-return
      // with no done). The tool tree is display-only: clear it so it does not become history.
      return {
        ...flushToolActivity(flushStreaming(settleReasoning(state, Date.now()))),
        turn: undefined,
      };
    case "reasoning-flushed":
      return openOrAppendReasoning(state, action.text, action.startedAt);
    case "reasoning-toggled":
      return toggleReasoning(state);
    case "queue-appended":
      // `selected` and `editing` are carried through untouched, not reset: a message queued while
      // the user is part-way through editing an earlier row must not move the band out from under
      // them or close the editor. On an empty queue normalizeQueue pins the new row at 0 anyway.
      return {
        ...state,
        queue: normalizeQueue(
          [...state.queue.items, { id: action.id, text: action.text }],
          state.queue.selected,
          state.queue.editing,
        ),
      };
    case "queue-selection-moved":
      // The retargeting bug TuiAction's own comment above describes: while a row is open in the
      // editor, the band must not move, because `selected` is what the commit writes into.
      if (state.queue.editing || state.queue.items.length === 0) return state;
      return {
        ...state,
        queue: normalizeQueue(
          state.queue.items,
          state.queue.selected + action.delta,
          state.queue.editing,
        ),
      };
    case "queue-edit-started":
      // Already editing: there is nothing to start, and returning `state` itself rather than an
      // equal-but-fresh object means a mashed Ctrl+E cannot even re-render the mounted editor.
      // Empty: `editing` with no items is precisely what the MessageQueue invariant rules out.
      if (state.queue.editing || state.queue.items.length === 0) return state;
      return { ...state, queue: { ...state.queue, editing: true } };
    case "queue-edit-committed": {
      // A blank commit keeps the original text rather than emptying the row: InputBox submits on a
      // bare Enter too, and an Enter on an editor the user has cleared reads as "never mind", not
      // as "make this queued message the empty string". cli.ts's onSubmit already routes that case
      // to `queue-edit-cancelled` before it gets here; this is the same answer stated where the
      // text actually changes, so the reducer is correct on its own terms.
      const items =
        action.text.trim().length === 0
          ? state.queue.items
          : state.queue.items.map((item, index) =>
              index === state.queue.selected ? { ...item, text: action.text } : item,
            );
      return { ...state, queue: normalizeQueue(items, state.queue.selected, false) };
    }
    case "queue-edit-cancelled":
      return { ...state, queue: { ...state.queue, editing: false } };
    case "queue-item-dropped": {
      // No-op while editing, for the same family of reasons as the two cases above: the selected
      // row is currently a mounted InputBox holding half-typed text, and dropping it would destroy
      // that mount with no keypress of the user's that meant "throw this away".
      if (state.queue.editing || state.queue.items.length === 0) return state;
      return {
        ...state,
        queue: normalizeQueue(
          state.queue.items.filter((_, index) => index !== state.queue.selected),
          state.queue.selected,
          false,
        ),
      };
    }
    case "queue-head-taken": {
      // `selected - 1`, not `selected`: every remaining row just shifted up by one, so subtracting
      // keeps the band on the SAME message rather than sliding it onto the next one down. When the
      // head itself was selected, normalizeQueue clamps the -1 back to the new head.
      const [, ...rest] = state.queue.items;
      return { ...state, queue: normalizeQueue(rest, state.queue.selected - 1, false) };
    }
    case "subagent-child-event":
      return applyChildEvent(state, action);
    case "subagent-panel-focus":
      return {
        ...state,
        subagentPanelFocus: true,
        subagentPanelSelectedId: state.subagentPanelSelectedId ?? "main",
      };
    case "subagent-panel-blur":
      return { ...state, subagentPanelFocus: false };
    case "subagent-panel-select":
      return { ...state, subagentPanelSelectedId: action.id };
    case "subagent-overlay-open":
      return { ...state, pendingChildView: action.id, subagentPanelFocus: false };
    case "subagent-overlay-close":
      return { ...state, pendingChildView: undefined };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

// Commits any pending streamed text as its own transcript line before appending `line`, so a
// tool-call/done/error that arrives mid-stream does not discard the model's partial answer.
// `flush: false` (a submission echo — see TuiAction's own comment) skips that flush-transfer
// entirely and leaves `state.streaming` untouched: not moved into `transcript` (still committed
// later, whole, by whatever event finishes the turn) and not cleared either (clearing it would
// silently drop the model's in-progress text instead of just deferring its commit).
function pushLine(
  state: TuiState,
  line: string,
  role: TranscriptRole = "system",
  flush = true,
  muted = false,
  markdown = false,
  kind?: TranscriptEntry["kind"],
): TuiState {
  const entry: TranscriptEntry = {
    role,
    text: line,
    ...(muted ? { muted: true } : {}),
    ...(markdown ? { markdown: true } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
  if (!flush) {
    return { ...state, transcript: [...state.transcript, entry] };
  }
  const flushedStreaming: TranscriptEntry[] =
    state.streaming.length > 0 ? [{ role: "assistant", text: state.streaming }] : [];
  return {
    ...state,
    transcript: [...state.transcript, ...flushedStreaming, entry],
    streaming: "",
  };
}

// Commits any pending streamed text as its own assistant transcript line without adding a
// system line — tool-call/result/permission-denied never push transcript lines (the tree is
// live-only), but a mid-stream tool-call still has to park the model's partial answer so
// later text-deltas don't concatenate onto it.
function flushStreaming(state: TuiState): TuiState {
  if (state.streaming.length === 0) return state;
  return {
    ...state,
    transcript: [...state.transcript, { role: "assistant", text: state.streaming }],
    streaming: "",
  };
}

function flushToolActivity(state: TuiState): TuiState {
  const summary = formatToolSummary(state.toolActivity);
  if (summary === undefined) return { ...state, toolActivity: [] };
  return {
    ...state,
    transcript: [...state.transcript, { role: "system", text: summary, muted: true }],
    toolActivity: [],
  };
}

// Folds one completed model call's real usage onto `progress`'s running totals — shared by the
// standalone `"usage"` event and `"compacted"`'s own bundled summarizer usage (loop.ts), both of
// which are genuinely billed calls this turn's displayed total must include. ADDS onto
// `reconciled*Tokens` rather than replacing them: a tool-using turn makes several completed model
// calls (loop.ts's own per-iteration loop), and the running total TurnStatus shows must be the SUM
// of every one of them, not just the latest — see `TokenProgress`'s own comment.
//
// Some providers/gateways return a `LanguageModelUsage` with only ONE of `inputTokens`/
// `outputTokens` defined, or even neither (confirmed against real upstream `vercel/ai` reports, and
// loop.ts's own comment on its failed-mid-stream `usage` yield) — each defined field is folded in on
// its own, so a real, known number is never discarded just because its sibling is missing.
// `liveInputEstimate` only resets to 0 when `inputTokens` itself is real; when it's missing, the live
// estimate is the only information that side of this call ever gets, so it is kept rather than
// zeroed. `liveOutputEstimate` is reset to 0 by EVERY reconciliation, whether or not `outputTokens`
// was real: when it was, it's already folded into `reconciledOutputTokens`; when it wasn't, it is
// moved onto `carriedOutputEstimate` instead — leaving it sitting in `liveOutputEstimate` would let
// the NEXT call's own `"text-delta"` accumulation add its growing estimate on top of this stranded
// one, indistinguishable from it, and a later reconciliation could then discard the blend instead of
// just this call's own share of it. A call missing either field also sets `hasGap` (see
// `TokenProgress`'s own comment): that field's true value for THIS call is gone forever, since no
// later call's own `usage` describes it — including a call missing BOTH fields, which used to be a
// total no-op (leaving `hasGap` unset even though nothing was ever learned about that call).
function reconcileUsage(progress: TokenProgress, usage: LanguageModelUsage): TokenProgress {
  const { inputTokens, outputTokens } = usage;
  const complete = inputTokens !== undefined && outputTokens !== undefined;
  return {
    reconciledInputTokens: progress.reconciledInputTokens + (inputTokens ?? 0),
    reconciledOutputTokens: progress.reconciledOutputTokens + (outputTokens ?? 0),
    liveInputEstimate: inputTokens === undefined ? progress.liveInputEstimate : 0,
    carriedOutputEstimate:
      progress.carriedOutputEstimate +
      (outputTokens === undefined ? progress.liveOutputEstimate : 0),
    liveOutputEstimate: 0,
    exact: complete,
    hasGap: progress.hasGap || !complete,
  };
}

function openOrAppendReasoning(state: TuiState, text: string, startedAt: number): TuiState {
  if (text.length === 0) return state;
  if (state.reasoning.live !== undefined) {
    return {
      ...state,
      reasoning: {
        ...state.reasoning,
        live: { ...state.reasoning.live, text: state.reasoning.live.text + text },
      },
    };
  }
  return {
    ...state,
    reasoning: { ...state.reasoning, live: { text, startedAt } },
  };
}

function withoutPriorReasoningBodies(transcript: TranscriptEntry[]): TranscriptEntry[] {
  let changed = false;
  const next = transcript.map((entry) => {
    if (entry.kind !== "reasoning") return entry;
    if (entry.body === undefined && entry.expanded !== true) return entry;
    changed = true;
    return {
      role: entry.role,
      text: formatReasoningCaret(false, entry.elapsedMs ?? 0),
      muted: entry.muted,
      kind: entry.kind,
      expanded: false,
      elapsedMs: entry.elapsedMs,
    };
  });
  return changed ? next : transcript;
}

function settleReasoning(state: TuiState, now: number): TuiState {
  const live = state.reasoning.live;
  if (live === undefined) return state;
  if (live.text.length === 0) {
    return { ...state, reasoning: { ...state.reasoning, live: undefined } };
  }
  const expanded = state.reasoning.expanded;
  const elapsedMs = now - live.startedAt;
  const entry: TranscriptEntry = {
    role: "system",
    text: formatReasoningCaret(expanded, elapsedMs),
    muted: true,
    kind: "reasoning",
    body: live.text,
    expanded,
    elapsedMs,
  };
  return {
    ...state,
    transcript: [...withoutPriorReasoningBodies(state.transcript), entry],
    reasoning: { ...state.reasoning, live: undefined },
  };
}

function toggleReasoning(state: TuiState): TuiState {
  if (state.reasoning.live !== undefined) {
    return { ...state, reasoning: { ...state.reasoning, expanded: !state.reasoning.expanded } };
  }
  let last = -1;
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    if (state.transcript[i]?.kind === "reasoning") {
      last = i;
      break;
    }
  }
  if (last < 0) return state;
  const entry = state.transcript[last];
  if (entry === undefined) return state;
  const expanded = !entry.expanded;
  const next = [...state.transcript];
  next[last] = {
    ...entry,
    expanded,
    text: formatReasoningCaret(expanded, entry.elapsedMs ?? 0),
  };
  return { ...state, transcript: next, reasoning: { ...state.reasoning, expanded } };
}

function applyLoopEvent(state: TuiState, event: LoopEvent): TuiState {
  switch (event.type) {
    // `state.turn` is left untouched (not seeded here) when it's `undefined` — a `text-delta`
    // arriving without a preceding `turn-started` would only happen out of order, which nothing in
    // this file crashes on; see this switch's other cases for the same posture.
    case "text-delta": {
      const settled = settleReasoning(state, Date.now());
      return {
        ...settled,
        streaming: settled.streaming + event.text,
        turn: settled.turn && {
          ...settled.turn,
          tokens: {
            ...settled.turn.tokens,
            liveOutputEstimate: settled.turn.tokens.liveOutputEstimate + estimateTokens(event.text),
            // A fresh live estimate has started for whichever call is now streaming — even
            // right after a `"usage"` event reconciled the PREVIOUS call and set this `true`.
            exact: false,
          },
        },
      };
    }
    case "reasoning-delta":
      return openOrAppendReasoning(state, event.text, Date.now());
    // Tool-call/result/permission-denied do not push a transcript line here. Stats accumulate
    // on `toolActivity` — the live-paint source during the turn (app.tsx) — and discarded on
    // done (not error: loop.ts yields error and continues). pendingTool is set
    // for every tool name so the live status slot (app.tsx) can show the in-flight call.
    // recordCall on tool-call so a thrown execute (tool-call then error, no tool-result) still
    // has a group for recordThrow to settle.
    case "tool-call": {
      const settled = settleReasoning(state, Date.now());
      return {
        ...flushStreaming(settled),
        status:
          event.name === "dispatch_subagents" || event.name === TODO_TOOL_NAME
            ? ""
            : `Running ${event.name}…`,
        pendingTool: { name: event.name, args: event.args },
        toolActivity: recordCall(settled.toolActivity, event.name, event.args),
      };
    }
    case "tool-result": {
      const nextList = event.name === TODO_TOOL_NAME ? parseTodoList(event.result) : undefined;
      return {
        ...state,
        ...(event.name === "dispatch_subagents" ? EMPTY_ROSTER : {}),
        ...(nextList !== undefined ? { checklist: nextList } : {}),
        toolActivity: recordResult(
          state.toolActivity,
          event.name,
          state.pendingTool?.args,
          event.result,
        ),
        status: "",
        pendingTool: undefined,
      };
    }
    case "permission-denied":
      return {
        ...state,
        toolActivity: recordDenial(state.toolActivity, event.name, event.reason),
        status: "",
        pendingTool: undefined,
      };
    case "tool-allowed":
      // Immediate, not deferred — toolAllowedLine (cli/output.ts), same as printEvent, so the
      // grant the user just made is visible before the turn ends.
      return {
        ...pushLine(state, toolAllowedLine(event.name)),
        status: "",
      };
    // `event.usage` is the summarizer's own round-trip cost — genuinely billed, and folded into
    // `state.turn`'s tokens the same way the standalone `"usage"` event below is, so a turn that
    // triggers mid-conversation compaction doesn't silently under-report its real spend.
    case "compacted":
      return {
        ...pushLine(state, `⚙ compacted ${event.evictedCount} messages`),
        turn: state.turn && {
          ...state.turn,
          tokens: reconcileUsage(state.turn.tokens, event.usage),
        },
      };
    case "retry":
      return pushLine(state, `↻ rate-limited or unavailable; retrying (attempt ${event.attempt})`);
    // Left as a no-op when `state.turn` is `undefined` — same out-of-order posture as `text-delta`
    // above.
    case "usage":
      return state.turn === undefined
        ? state
        : {
            ...state,
            turn: { ...state.turn, tokens: reconcileUsage(state.turn.tokens, event.usage) },
          };
    // The one case that DOES belong to the screen after all, corrected from the no-op this used
    // to be: driveLoop no longer computes the merge itself from a session var it closed over once
    // at the start of a turn (a real bug — a mid-run /mode dispatched a fresh `session-updated`
    // action, and the NEXT messages-updated event then overwrote it right back with driveLoop's
    // stale copy, on disk and in the reducer both). Merging into `state.session` — this reducer's
    // own CURRENT session, not anything the caller remembers — is what makes the reducer the
    // single source of truth for both the live session state and (via App.tsx's own persistence
    // effect watching `state.session`) what actually lands on disk.
    case "messages-updated":
      return {
        ...state,
        session: { ...state.session, messages: event.messages },
        checklist: todoListFromMessages(event.messages),
      };
    case "done": {
      const settled = settleReasoning(state, Date.now());
      return {
        ...pushLine(
          flushToolActivity(settled),
          formatDoneLine(event.reason, settled.turn?.tokens),
          "system",
          true,
          true,
        ),
        status: "",
        pendingTool: undefined,
      };
    }
    // `state.turn` is deliberately left untouched here — see `"turn-ended"`'s own comment
    // (TuiAction) for why only that action, not this event, ends a turn. toolActivity is
    // also left in place: an error is not turn-end, and flushing here would drop calls
    // that arrive after the error. A thrown execute (pendingTool set) settles that open
    // group as an anomaly instead of dumping the loop's model-facing wrapper as a
    // transcript peer of the assistant's prose. Other errors (compaction, unknown tool,
    // a failed stream) still push a marked system line. A hosted quota notice is
    // the same event without the mark.
    case "error": {
      const pending = state.pendingTool;
      if (pending !== undefined) {
        return {
          ...state,
          toolActivity: recordThrow(state.toolActivity, pending.name, pending.args, event.error),
          status: "",
          pendingTool: undefined,
        };
      }
      if (isQuotaExhaustedNotice(event.error)) {
        return {
          ...pushLine(state, event.error, "system", true, false, false, "quota-exhausted"),
          status: "",
          pendingTool: undefined,
        };
      }
      return {
        ...pushLine(state, `${ERROR_MARK}${event.error}`),
        status: "",
        pendingTool: undefined,
      };
    }
    default: {
      const _unhandled: never = event;
      return state;
    }
  }
}
