// The shared-state home the research spec's Constraint 4 requires: driveLoop and all four slash
// commands dispatch into this one reducer rather than each holding a separate copy. Zero Ink/React
// import — a plain, standalone reducer, testable without a terminal.
import type { ModelProvider } from "@seri/model-catalog";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { toolAllowedLine, toolResultLine } from "../../cli/output";
import type { PermissionMode } from "../../gate/gate";
import type { LoopEvent } from "../../loop/loop";
import type { ResolvedRoute } from "../../provider/routing";
import type { SessionState } from "../../session/session";
import {
  DEFAULT_COLUMNS,
  estimateTokens,
  type TokenProgress,
  type TranscriptEntry,
  type TranscriptRole,
  transcriptVisualRows,
} from "../util/format";
import type { ConfigRow, ModelPickerEntry, PermissionRow, SetupProviderRow } from "./commands";

// /setup's own live state — a three-step flow, mirrored on the reducer
// the same way /model's picker is: "list" shows all five providers, "enter-key" is the masked
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
    }
  | { step: "confirm-remove"; provider: ModelProvider; keyName: string };

// /login and /signup's own live state — the device-flow OAuth panel. "starting" is the brief
// moment before the provider returns a verification URL/code; "device" shows that URL+code for the
// user to open in a browser; "result" is the terminal state (success or failure).
export type AuthPanelState =
  | { step: "starting"; mode: "login" | "signup" }
  | { step: "device"; mode: "login" | "signup"; verificationUri: string; userCode: string }
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

export type TuiState = {
  session: SessionState<ModelMessage>;
  // Append-only committed LOGICAL lines — one entry per `transcript-append`/pushLine call, never
  // re-split or re-joined here. Rendered by App.tsx as a scrollable viewport (visibleTranscript,
  // format.ts), which wraps each entry to `columns` VISUAL rows on read, not on write: a hard-wrap
  // break is indistinguishable from a real `\n` once written, so storing the wrapped output would
  // make a resize lossy (the old width's wrapping can never be un-done to re-wrap at the new one).
  // Keeping this array untouched is what makes a resize a free re-derivation instead of a rewrite.
  // Each entry carries a `role` ("user"/"assistant"/"system") alongside its logical text — used at
  // render time to top-anchor a short transcript, band a user turn's rows with a background color,
  // and prefix an assistant answer with its own marker (App.tsx), without changing what gets stored.
  transcript: TranscriptEntry[];
  // VISUAL rows from the BOTTOM of the (wrapped) transcript the viewport is scrolled up by. 0 =
  // following the latest row (the default, and the state End returns to). Advanced by pushLine
  // while > 0, by however many visual rows a flush actually added — see `appendLines`' own
  // comment — so a scrolled-up view stays anchored on the same content as new rows arrive, rather
  // than sliding out from under the reader mid-read.
  transcriptScrollOffset: number;
  // The terminal's own current width and the transcript viewport's own current height, in rows —
  // kept on state (not threaded through every `transcript-scroll` action the way `viewportRows`
  // used to be) so the scroll clamp and a resize both read the same two numbers from one place
  // instead of re-deriving them at every call site. Seeded from `DEFAULT_COLUMNS`/a small
  // placeholder here — App.tsx's own resize effect corrects both to the real measured values
  // before the first real transcript content is ever appended (see that effect's own comment for
  // why the ordering is guaranteed, not assumed).
  columns: number;
  viewportRows: number;
  // `transcriptVisualRows(transcript, columns)` (format.ts), cached rather than recomputed by every
  // scroll/resize case below (found by review): that function re-wraps the ENTIRE transcript, and
  // PageUp/PageDown auto-repeat at the OS key-repeat rate, so recomputing it per dispatch meant
  // holding either key re-wrapped the whole session's history on every repeat tick. Kept correct by
  // construction, not by re-deriving: `appendLines` advances it by the NEW lines' own row count
  // (cheap, proportional to what was just added) and `viewport-resized` is the only case that ever
  // recomputes it from scratch, and only when `columns` actually changed — the one time the cached
  // value can no longer be trusted, since every existing entry re-wraps to a different row count.
  totalVisualRows: number;
  // The model's in-progress answer, not yet committed to the transcript — the live region's
  // content, flushed into `transcript` the moment a non-text event needs to report.
  streaming: string;
  // The live region's spinner/status line, cleared once whatever it was reporting on finishes.
  status: string;
  // Set by `turn-started` (dispatched once per turn, before the model is invoked) and cleared by
  // `turn-ended` — see that action's own comment for why it, not a bare `"error"` event, is what
  // ends a turn. `undefined` means no turn is in flight, which is what TurnStatus (app.tsx) reads to
  // decide whether to render at all. `startedAt` is a wall-clock timestamp, not a running counter —
  // see TurnStatus's own comment for why.
  turn: { startedAt: number; tokens: TokenProgress } | undefined;
  modeIndicator: string;
  // The in-flight write_file/edit call, if any — set on that tool's own tool-call event, cleared
  // on its tool-result/permission-denied. A dedicated field rather than App.tsx string-matching
  // `status`'s rendered text (`"Running write_file…"`) against the last transcript line, which
  // only worked by coincidence and would silently stop working the moment either string changed.
  pendingTool: { name: string; args: unknown } | undefined;
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
  pendingApproval: { toolName: string; args: unknown; offersAlways: boolean } | undefined;
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
  // The non-blocking login/signup offer (AuthBanner, App.tsx) — independent of `pendingAuth`
  // below, not a fourth mutually exclusive render-ternary state. Set by the `auth-offer` action
  // (decideAuthOffer, dispatched from cli.ts/handlers.ts at every point the auth panel closes).
  authOffer: boolean;
  // /login and /signup's own blocking panel. Mirrors `pendingSetup`'s mutual-exclusion role in the
  // render ternary.
  pendingAuth: AuthPanelState | undefined;
  // /config's own blocking panel. Mirrors `pendingSetup`'s role.
  pendingConfig: ConfigPanelState | undefined;
  // /permissions' own blocking panel. Mirrors `pendingSetup`'s role.
  pendingPermissions: PermissionsPanelState | undefined;
  // The welcome-splash mount's own blocking panel. `initialTuiState`'s own `showSplash` opt (below)
  // only seeds the value App.tsx's OWN internal `useReducer(tuiReducer, initialTuiState(session))`
  // call starts from — that call never passes `showSplash`, so every App instance still mounts with
  // this `false` until `runWelcomeSplash`'s own `connectDispatch` fires `splash-requested` on mount,
  // the same "seed false, flip true via a requested action fired at mount" shape `pendingSetup`/
  // `pendingAuth` already use. `runTui` and `runGuidedSetup` never dispatch it, so their own
  // separate App instances never render WelcomeSplash for the same launch.
  pendingSplash: boolean;
  // The status bar's own model+route label reads this, not `AppProps.route` (App.tsx's own
  // comment on that prop) — the prop only seeds this field at mount; every later switch reaches
  // the label by dispatching `route-updated` instead, the same "reducer state, not a caller-held
  // copy" shape `session` above already uses. Optional for the identical reason `AppProps.route`
  // is: runGuidedSetup mounts App before any provider key/route exists yet.
  route: ResolvedRoute | undefined;
};

function modeIndicator(mode: PermissionMode): string {
  return `[${mode}]`;
}

// What "an empty transcript" means, as a single value rather than four fields independently kept
// in sync at two call sites (initialTuiState below, and the `transcript-cleared` case's own
// comment on why every one of them must move together): a future field added to this set only
// needs updating here once. `Readonly<Pick<TuiState, ...>>` (rather than a cast) means a field
// removed from TuiState is a compile error here too, not just a silent orphan. Both the object and
// its `transcript` array are frozen: every TuiState this is spread into shares the SAME array
// instance, so an in-place mutation of one state's `transcript` (nothing does this today, but
// nothing stops it either) would otherwise corrupt every other state — including a concurrent test
// — that spread from this same constant.
const EMPTY_TRANSCRIPT: Readonly<
  Pick<TuiState, "transcript" | "transcriptScrollOffset" | "totalVisualRows" | "streaming">
> = Object.freeze({
  // `as TranscriptEntry[]`: TuiState.transcript is declared mutable (App.tsx replaces it wholesale
  // rather than pushing in place), and TS's array variance treats `readonly T[]` and `T[]` as
  // genuinely different types — frozen at runtime regardless of this cast, which only restores the
  // static type this field is spread into everywhere else.
  transcript: Object.freeze([] as TranscriptEntry[]) as TranscriptEntry[],
  transcriptScrollOffset: 0,
  totalVisualRows: 0,
  streaming: "",
});

export function initialTuiState(
  session: SessionState<ModelMessage>,
  opts?: { showSplash?: boolean; route?: ResolvedRoute },
): TuiState {
  return {
    session,
    route: opts?.route,
    ...EMPTY_TRANSCRIPT,
    columns: DEFAULT_COLUMNS,
    // Not a real chrome-height estimate, same spirit as App.tsx's own FALLBACK_CHROME_ROWS
    // placeholder — corrected by the first `viewport-resized` dispatch before it can matter.
    viewportRows: 1,
    status: "",
    turn: undefined,
    modeIndicator: modeIndicator(session.permissionMode),
    pendingTool: undefined,
    commandError: undefined,
    pendingApproval: undefined,
    pendingModelPicker: undefined,
    pendingInputPrefill: undefined,
    pendingSetup: undefined,
    authOffer: false,
    pendingAuth: undefined,
    pendingConfig: undefined,
    pendingPermissions: undefined,
    pendingSplash: opts?.showSplash ?? false,
  };
}

export type TuiAction =
  | { type: "session-updated"; session: SessionState<ModelMessage> }
  // `flush` defaults to true (every existing caller relies on that) — set to false by a submission
  // echo that must not fragment an in-progress streamed answer into two transcript entries (see
  // pushLine's own comment).
  | { type: "transcript-append"; line: string; role?: TranscriptRole; flush?: boolean }
  // /clear's own action. The only action that ever SHRINKS the transcript, rather than adding to
  // it — every derived counter (`transcriptScrollOffset`, `totalVisualRows`, `streaming`) must be
  // reset alongside `transcript` itself, or a stale one would keep describing an array that no
  // longer exists.
  | { type: "transcript-cleared" }
  // Scrolls the transcript viewport. Positive `delta` moves toward older rows, clamped to
  // `[0, transcriptVisualRows(transcript, columns) - viewportRows]` — the offset at which
  // visibleTranscript shows a full `viewportRows`-tall page of the oldest content, not just the
  // single oldest row (`totalRows - 1` would slice down to one row pinned to the bottom by
  // `justifyContent="flex-end"`, App.tsx).
  | { type: "transcript-scroll"; delta: number }
  | { type: "transcript-scroll-to"; to: "top" | "bottom" }
  // Dispatched by App.tsx's own resize effect whenever the measured terminal width or transcript
  // viewport height changes (mount included — see that effect's own comment). One action for both
  // numbers, not two, since a real terminal resize changes both at once and a caller that dispatched
  // them separately could transiently wrap new content to a stale width while the height was
  // already current, or vice versa. Also re-clamps `transcriptScrollOffset` against the new
  // `viewportRows`, which is what closes the "grow the terminal while scrolled up" bug this action
  // replaced a zero-delta `transcript-scroll` workaround for.
  | { type: "viewport-resized"; columns: number; viewportRows: number }
  | { type: "loop-event"; event: LoopEvent }
  | { type: "command-error"; message: string }
  | { type: "command-error-cleared" }
  | { type: "approval-requested"; toolName: string; args: unknown; offersAlways: boolean }
  | { type: "approval-resolved" }
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
  // `auth-offer` toggles the independent, non-blocking banner — deliberately NOT `pendingAuth`,
  // which is the blocking panel (see TuiState's own comment).
  | { type: "auth-offer"; show: boolean }
  | { type: "auth-requested"; mode: "login" | "signup" }
  | { type: "auth-step"; state: AuthPanelState }
  | { type: "auth-resolved"; leftoverInput?: string }
  | { type: "config-requested"; rows: ConfigRow[] }
  | { type: "config-step"; state: ConfigPanelState }
  | { type: "config-resolved"; leftoverInput?: string }
  | { type: "permissions-requested"; rows: PermissionRow[] }
  | { type: "permissions-step"; state: PermissionsPanelState }
  | { type: "permissions-resolved"; leftoverInput?: string }
  | { type: "splash-requested" }
  | { type: "splash-resolved" }
  // Dispatched by runTurn (cli.ts) right after its own per-turn `resolveRoute` call succeeds —
  // the fix for issue #132: the status bar's label used to be frozen at mount (App.tsx's own
  // `route` prop, never re-read after the initial render), so a /model switch's own freshly
  // resolved route never reached it. `state.route` is what the label now reads.
  | { type: "route-updated"; route: ResolvedRoute }
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
  | { type: "turn-ended" };

// A shorthand for "given this action, do something with it": App.tsx's own `connectDispatch`
// prop (the reducer's own `useReducer` dispatch, handed back to cli.ts's runTui), runTui's own
// `dispatch` handle built from it, and tuiPresenter (cli.ts), which dispatches into it rather
// than printing. driveLoop itself takes a plain `onEvent: (event: LoopEvent) => void` now, not
// this — it only ever dispatched one action shape, so it no longer needs to know TuiAction
// exists at all. Lives here, not cli.ts, since it is built from TuiAction, declared right above.
export type Dispatch = (action: TuiAction) => void;

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "session-updated":
      return {
        ...state,
        session: action.session,
        modeIndicator: modeIndicator(action.session.permissionMode),
      };
    // pushLine, not a bare append: this used to be harmless when transcript-append had no real
    // callers, but tuiPresenter.message, undoPlanLines/recoveryLines and quit()'s own "quitting -
    // cancelling..." line all go through this case now, and the last of those fires specifically
    // WHILE a turn may still be streaming text — without flushing here first, a /mode or /exit
    // typed mid-stream reordered the transcript against the model's own still-in-progress answer.
    case "transcript-append":
      return pushLine(state, action.line, action.role ?? "system", action.flush ?? true);
    case "transcript-cleared":
      return {
        ...state,
        ...EMPTY_TRANSCRIPT,
      };
    case "transcript-scroll": {
      const max = maxScrollOffset(
        state.totalVisualRows,
        state.turn !== undefined ? 1 : 0,
        state.viewportRows,
      );
      const next = Math.min(max, Math.max(0, state.transcriptScrollOffset + action.delta));
      return { ...state, transcriptScrollOffset: next };
    }
    case "transcript-scroll-to": {
      return {
        ...state,
        transcriptScrollOffset:
          action.to === "top"
            ? maxScrollOffset(
                state.totalVisualRows,
                state.turn !== undefined ? 1 : 0,
                state.viewportRows,
              )
            : 0,
      };
    }
    case "viewport-resized": {
      // Only a genuine `columns` change invalidates the cache: every existing entry re-wraps to a
      // different row count then, and that's the one time re-deriving it from scratch is correct
      // AND unavoidable — `viewportRows` alone changing (the far more common case, since it tracks
      // measured box height and can jitter by a row across renders) never changes how many VISUAL
      // rows the transcript occupies, only how many of them fit on screen at once.
      const totalVisualRows =
        action.columns === state.columns
          ? state.totalVisualRows
          : transcriptVisualRows(state.transcript, action.columns);
      const max = maxScrollOffset(
        totalVisualRows,
        state.turn !== undefined ? 1 : 0,
        action.viewportRows,
      );
      return {
        ...state,
        columns: action.columns,
        viewportRows: action.viewportRows,
        totalVisualRows,
        transcriptScrollOffset: Math.min(max, state.transcriptScrollOffset),
      };
    }
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
        },
      };
    case "approval-resolved":
      return { ...state, pendingApproval: undefined };
    case "model-picker-requested":
      return { ...state, pendingModelPicker: { entries: action.entries } };
    case "model-picker-resolved":
      // Merged into `state.session` (this reducer's own current session), not a caller-captured
      // one — see TuiAction's own comment on `pick`. `permissionMode` is untouched by a pick, so
      // (unlike session-updated, above) there is no `modeIndicator` to recompute here.
      //
      // `route` is also updated optimistically here, not just `session` — otherwise the status
      // bar (which reads `state.route`) stays on the OLD model until the next turn's
      // `route-updated` dispatch (cli.ts's runTurn), one full turn after the pick that's visibly
      // supposed to have already switched it. Only done when `keyConfigured` is true, though: that's
      // the one case this reducer can resolve on its own (Rule 1 of `resolveRoute`, routing.ts — a
      // provider with its own key always wins unrerouted). When it's false, the picked provider will
      // be rerouted or gateway-served, but WHERE it lands is `resolveRoute`'s computation (it needs
      // the catalog/configured-providers/plan this reducer doesn't have) — guessing `rerouted: false`
      // here would render "your key" for a provider the user doesn't actually have a key for, exactly
      // the fabricated-route claim `formatModeLabel`'s own comment says to avoid. `state.route` is
      // left as-is (stale for the one turn until `route-updated` supplies the real answer) rather
      // than asserting something false.
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
        route: action.pick.keyConfigured
          ? {
              model: action.pick.model,
              provider: action.pick.provider,
              rerouted: false,
              viaGateway: false,
            }
          : state.route,
      };
    case "input-prefill-consumed":
      return { ...state, pendingInputPrefill: undefined };
    case "setup-requested":
      return { ...state, pendingSetup: { step: "list", rows: action.rows, selected: 0 } };
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
    case "splash-requested":
      return { ...state, pendingSplash: true };
    case "splash-resolved":
      return { ...state, pendingSplash: false };
    case "route-updated":
      return { ...state, route: action.route };
    case "turn-started":
      return {
        ...state,
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
    // Re-clamps `transcriptScrollOffset`, not just a bare `turn: undefined`: ending a turn drops
    // `TurnStatus`'s own reserved row, so `maxScrollOffset` shrinks by 1 — a reader parked exactly
    // at the OLD ceiling (Home, e.g.) would otherwise sit one row past the new one until their next
    // scroll action, and `visibleTranscript` (format.ts) would render a blank row at the top instead
    // of a full page. Same re-clamp `transcript-scroll`/`transcript-scroll-to`/`viewport-resized`
    // already do on their own ceiling-narrowing paths, applied here for the one ceiling change none
    // of those three actions themselves ever dispatch for.
    case "turn-ended": {
      const max = maxScrollOffset(state.totalVisualRows, 0, state.viewportRows);
      return {
        ...state,
        turn: undefined,
        transcriptScrollOffset: Math.min(max, state.transcriptScrollOffset),
      };
    }
  }
}

// The furthest `transcriptScrollOffset` can go: every visual row that exists, committed plus
// `TurnStatus`'s own reserved row, minus the ones already on screen. `streamingRows` is
// `state.turn !== undefined ? 1 : 0` at every call site — `TurnStatus` occupies exactly one row of
// the transcript box for the whole turn (App.tsx's own comment on its render location), not a
// count that grows with `state.streaming`.
function maxScrollOffset(
  totalVisualRows: number,
  streamingRows: number,
  viewportRows: number,
): number {
  return Math.max(0, totalVisualRows + streamingRows - viewportRows);
}

// Commits any pending streamed text as its own transcript line before appending `line`, so a
// tool-call/done/error that arrives mid-stream does not discard the model's partial answer.
// `flush: false` (a submission echo — see TuiAction's own comment) skips that flush-transfer
// entirely and leaves `state.streaming` untouched: not moved into `transcript` (still committed
// later, whole, by whatever event finishes the turn) and not cleared either (clearing it would
// silently drop the model's in-progress text instead of just deferring its commit).
// A blank `{role: "system", text: ""}` separator is inserted immediately before `line` when it is
// a new user turn (`role === "user"`) following existing content — `wrapForTranscript` (format.ts)
// already guarantees `""` survives as exactly one row, so this needs no new row-accounting path.
function pushLine(
  state: TuiState,
  line: string,
  role: TranscriptRole = "system",
  flush = true,
): TuiState {
  // Computed before the `flush` branch below, not inside the `flush: true` half of it: echoUserInput
  // (cli.ts) — the only call site that ever dispatches `role: "user"` — always passes `flush: false`,
  // so a separator that only existed on the `flush: true` path would never actually fire for a real
  // user turn.
  const separator: TranscriptEntry[] =
    role === "user" && state.transcript.length > 0 ? [{ role: "system", text: "" }] : [];
  if (!flush) return appendLines(state, [...separator, { role, text: line }]);
  const flushedStreaming: TranscriptEntry[] =
    state.streaming.length > 0 ? [{ role: "assistant", text: state.streaming }] : [];
  const appended = [...flushedStreaming, ...separator, { role, text: line }];
  return { ...appendLines(state, appended), streaming: "" };
}

// Appends one or more LOGICAL lines, untouched — no wrapping here; see TuiState.transcript's own
// comment for why the entries themselves must stay whatever was passed in. `addedRows` (the VISUAL
// row count the new lines add at the current `columns`, not `rawLines.length`) does two things:
// advances `totalVisualRows` (the cache `transcript-scroll`'s own clamp trusts — see that field's
// own comment) unconditionally, since it must stay correct regardless of scroll position; and, only
// while the viewport is scrolled up (`transcriptScrollOffset > 0`), advances the offset by the FULL
// `addedRows`, with no subtraction, so a scrolled-up view stays anchored on the same content as new
// rows arrive, rather than sliding out from under the reader mid-read.
//
// No subtraction for `TurnStatus`'s own reserved row, unlike a prior version of this function: that
// row does NOT convert into committed content the way the old (pre-buffer-then-reveal) streamed-text
// rows this function used to subtract did — a mid-turn flush (`pushLine`, from a tool-call/
// tool-result/permission-denied/tool-allowed/retry/compacted event) commits real new rows while
// `state.turn` stays defined, so `TurnStatus`'s reserved row is UNCHANGED by this call, still sitting
// exactly where it was. Subtracting anything here (verified live: reverting to a
// `resolvedStreamingRows`-style subtraction and re-running this file's own flush-anchoring test)
// drifted a scrolled-up reader's view by 1 row on every mid-turn flush instead of leaving it
// anchored. Only `"turn-ended"` (above) changes the reserved row, and it re-clamps the offset
// directly rather than through this function, since ending a turn commits no new lines at all.
function appendLines(state: TuiState, rawLines: TranscriptEntry[]): TuiState {
  const addedRows = transcriptVisualRows(rawLines, state.columns);
  return {
    ...state,
    transcript: [...state.transcript, ...rawLines],
    totalVisualRows: state.totalVisualRows + addedRows,
    transcriptScrollOffset:
      state.transcriptScrollOffset > 0 ? state.transcriptScrollOffset + addedRows : 0,
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

function applyLoopEvent(state: TuiState, event: LoopEvent): TuiState {
  switch (event.type) {
    // `state.turn` is left untouched (not seeded here) when it's `undefined` — a `text-delta`
    // arriving without a preceding `turn-started` would only happen out of order, which nothing in
    // this file crashes on; see this switch's other cases for the same posture.
    case "text-delta":
      return {
        ...state,
        streaming: state.streaming + event.text,
        turn: state.turn && {
          ...state.turn,
          tokens: {
            ...state.turn.tokens,
            liveOutputEstimate: state.turn.tokens.liveOutputEstimate + estimateTokens(event.text),
            // A fresh live estimate has started for whichever call is now streaming — even
            // right after a `"usage"` event reconciled the PREVIOUS call and set this `true`.
            exact: false,
          },
        },
      };
    case "tool-call":
      return {
        ...pushLine(state, `→ ${event.name}(${JSON.stringify(event.args)})`),
        status: `Running ${event.name}…`,
        pendingTool:
          event.name === "write_file" || event.name === "edit"
            ? { name: event.name, args: event.args }
            : state.pendingTool,
      };
    // toolResultLine/toolAllowedLine (cli/output.ts), not a hand-copied line shape — a hand-copied
    // one would drift from printEvent's own rendering (missing the edit-specific message and the
    // verification suffix here, missing escapeControlChars on tool-allowed's name); sharing the
    // same two functions closes that gap for good.
    case "tool-result":
      return { ...pushLine(state, toolResultLine(event)), status: "", pendingTool: undefined };
    case "permission-denied":
      return { ...pushLine(state, `✗ ${event.name} blocked`), status: "", pendingTool: undefined };
    case "tool-allowed":
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
      return { ...state, session: { ...state.session, messages: event.messages } };
    case "done":
      return { ...pushLine(state, `(done: ${event.reason})`), status: "", pendingTool: undefined };
    // `state.turn` is deliberately left untouched here — see `"turn-ended"`'s own comment
    // (TuiAction) for why only that action, not this event, ends a turn.
    case "error":
      return {
        ...pushLine(state, event.error),
        status: "",
        pendingTool: undefined,
      };
    default: {
      const _unhandled: never = event;
      return state;
    }
  }
}
