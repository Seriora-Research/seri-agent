// The shared-state home the research spec's Constraint 4 requires: driveLoop and all four slash
// commands dispatch into this one reducer rather than each holding a separate copy. Zero Ink/React
// import — a plain, standalone reducer, testable without a terminal.
import type { ModelProvider } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { toolAllowedLine, toolResultLine } from "../cli/output";
import type { PermissionMode } from "../gate/gate";
import type { LoopEvent } from "../loop/loop";
import type { SessionState } from "../session/session";
import type { ConfigRow, ModelPickerEntry, PermissionRow, SetupProviderRow } from "./commands";
import { DEFAULT_COLUMNS, transcriptVisualRows } from "./format";

// /setup's own live state (D5-D8, feature-plan.md) — a three-step flow, mirrored on the reducer
// the same way /model's picker is: "list" shows all five providers, "enter-key" is the masked
// text-entry step (add or replace), "confirm-remove" is a single-keypress y/n. "list" carries its
// own freshly-recomputed `rows` (SetupList, App.tsx, renders and navigates them) rather than
// reaching back into a stale copy, so a step transition always renders what config.json/env
// actually say at that moment. "enter-key" and "confirm-remove" do NOT carry `rows` — neither
// SetupEnterKey nor SetupConfirmRemove (App.tsx) reads a row list at all, only `provider`/
// `keyName` and their own step-specific fields; a `rows` field on either used to exist purely to
// satisfy the type, forcing cli.ts's own handlers to compute-and-thread a row array (a config.json
// read) nothing ever consumed (code-review, PR #73).
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

// Stage A (cli-commands-to-tui feature-plan.md): scaffolding only — this state has no dispatcher
// wired to it yet (no `auth-requested`/`config-requested`/`permissions-requested` caller exists
// until Stages B-D). Shaped now, alongside SetupState above, so those stages land as additive
// wiring rather than a reducer-state redesign.
//
// /login and /signup's own live state — the device-flow OAuth panel (Stage C). "starting" is the
// brief moment before the provider returns a verification URL/code; "device" shows that URL+code
// for the user to open in a browser; "result" is the terminal state (success or failure).
export type AuthPanelState =
  | { step: "starting"; mode: "login" | "signup" }
  | { step: "device"; mode: "login" | "signup"; verificationUri: string; userCode: string }
  | { step: "result"; message: string; error: boolean };

// /config's own live state (Stage D) — structurally identical to SetupState above (list ->
// enter-value -> list, list -> confirm-unset -> list), since /config edits arbitrary config.json
// keys the same way /setup edits provider API keys.
export type ConfigPanelState =
  | { step: "list"; rows: ConfigRow[]; selected: number }
  | { step: "enter-value"; key: string; error?: string; busy: boolean }
  | { step: "confirm-unset"; key: string };

// /permissions' own live state (Stage D) — a flat list with only a remove step, no value-entry
// step: there is nothing to type, only tools to revoke.
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
  transcript: string[];
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
  // content in Phase 4, flushed into `transcript` the moment a non-text event needs to report.
  streaming: string;
  // The live region's spinner/status line, cleared once whatever it was reporting on finishes.
  status: string;
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
  // Findings 1+5 (thermo-nuclear structural review, round 6): the TUI-native ApprovalPrompt's own
  // live state — set when runTui's tuiApprovalPrompt is called (a write-tool call reached the
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
  // Code-review finding: a single pty chunk carrying filter text, a terminator, AND further
  // characters (measured as real on a real terminal, the same class InputBox's own MEDIUM-E fix
  // addressed) used to just discard everything after the terminator when it closed the picker —
  // dropped keystrokes with the picker gone and no trace of what was typed. Set by
  // `model-picker-resolved`'s `leftoverInput`, consumed once by InputBox as its own starting
  // value on the very next mount, then cleared — never re-applied to a later, unrelated mount.
  pendingInputPrefill: string | undefined;
  // /setup's own live state — mirrors `pendingModelPicker`'s shape and mutual-exclusion role
  // exactly, extended to a fourth render-ternary branch (App.tsx). Can coexist with
  // `pendingApproval`/`pendingModelPicker` the same way those two already can with each other,
  // for the identical reason: cli.ts's onSubmit handles /setup before the turnInFlight guard.
  pendingSetup: SetupState | undefined;
  // Stage A scaffolding (cli-commands-to-tui feature-plan.md): the non-blocking login/signup
  // offer (AuthBanner, App.tsx) — independent of `pendingAuth` below, not a fourth mutually
  // exclusive render-ternary state. Nothing sets this to `true` yet (Stage C wires the offer).
  authOffer: boolean;
  // /login and /signup's own blocking panel (Stage C). Mirrors `pendingSetup`'s mutual-exclusion
  // role in the render ternary once wired; unreachable until then.
  pendingAuth: AuthPanelState | undefined;
  // /config's own blocking panel (Stage D). Mirrors `pendingSetup`'s role; unreachable until wired.
  pendingConfig: ConfigPanelState | undefined;
  // /permissions' own blocking panel (Stage D). Mirrors `pendingSetup`'s role; unreachable until
  // wired.
  pendingPermissions: PermissionsPanelState | undefined;
  // The welcome-splash mount's own blocking panel. `initialTuiState`'s own `showSplash` opt (below)
  // only seeds the value App.tsx's OWN internal `useReducer(tuiReducer, initialTuiState(session))`
  // call starts from — that call never passes `showSplash`, so every App instance still mounts with
  // this `false` until `runWelcomeSplash`'s own `connectDispatch` fires `splash-requested` on mount,
  // the same "seed false, flip true via a requested action fired at mount" shape `pendingSetup`/
  // `pendingAuth` already use. `runTui` and `runGuidedSetup` never dispatch it, so their own
  // separate App instances never render WelcomeSplash for the same launch.
  pendingSplash: boolean;
};

function modeIndicator(mode: PermissionMode): string {
  return `[${mode}]`;
}

export function initialTuiState(
  session: SessionState<ModelMessage>,
  opts?: { showSplash?: boolean },
): TuiState {
  return {
    session,
    transcript: [],
    transcriptScrollOffset: 0,
    columns: DEFAULT_COLUMNS,
    // Not a real chrome-height estimate, same spirit as App.tsx's own FALLBACK_CHROME_ROWS
    // placeholder — corrected by the first `viewport-resized` dispatch before it can matter.
    viewportRows: 1,
    totalVisualRows: 0,
    streaming: "",
    status: "",
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
  | { type: "transcript-append"; line: string; flush?: boolean }
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
      pick?: { model: string; provider: ModelProvider };
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
  // Stage A scaffolding: no dispatcher fires any of these ten yet (Stages B-D wire them). Shaped
  // now so `pendingAuth`/`pendingConfig`/`pendingPermissions`'s own step transitions have a
  // reducer contract to land on. `auth-offer` toggles the independent, non-blocking banner —
  // deliberately NOT `pendingAuth`, which is the blocking panel (see TuiState's own comment).
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
  | { type: "splash-resolved" };

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
      return pushLine(state, action.line, action.flush ?? true);
    case "transcript-scroll": {
      const max = Math.max(
        0,
        state.totalVisualRows +
          streamingVisualRows(state.streaming, state.columns) -
          state.viewportRows,
      );
      const next = Math.min(max, Math.max(0, state.transcriptScrollOffset + action.delta));
      return { ...state, transcriptScrollOffset: next };
    }
    case "transcript-scroll-to":
      return {
        ...state,
        transcriptScrollOffset:
          action.to === "top"
            ? Math.max(
                0,
                state.totalVisualRows +
                  streamingVisualRows(state.streaming, state.columns) -
                  state.viewportRows,
              )
            : 0,
      };
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
      const max = Math.max(
        0,
        totalVisualRows +
          streamingVisualRows(state.streaming, action.columns) -
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
      return action.pick === undefined
        ? { ...state, pendingModelPicker: undefined, pendingInputPrefill: action.leftoverInput }
        : {
            ...state,
            pendingModelPicker: undefined,
            pendingInputPrefill: action.leftoverInput,
            session: {
              ...state.session,
              model: action.pick.model,
              provider: action.pick.provider,
            },
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
  }
}

// The in-progress streamed answer's own visual row count at `columns` wide — `state.totalVisualRows`
// only ever tracks the COMMITTED transcript (see its own comment), so a scroll-bound clamp that
// used that cache alone could never reach rows still sitting in `state.streaming`: with an empty or
// short committed transcript and a streamed answer taller than one viewport, PageUp/Home computed
// their ceiling from `totalVisualRows` and could never move `transcriptScrollOffset` past 0, even
// though `visibleTranscript` (format.ts) renders `streaming` as real content above the viewport's
// tail. Only called from the three keypress/resize cases below — never from "text" (applyLoopEvent,
// below), which fires once per streamed token and cannot afford to re-wrap `streaming` on every one.
function streamingVisualRows(streaming: string, columns: number): number {
  return streaming.length > 0 ? transcriptVisualRows([streaming], columns) : 0;
}

// Commits any pending streamed text as its own transcript line before appending `line`, so a
// tool-call/done/error that arrives mid-stream does not discard the model's partial answer.
// `flush: false` (a submission echo — see TuiAction's own comment) skips that flush-transfer
// entirely and leaves `state.streaming` untouched: not moved into `transcript` (still committed
// later, whole, by whatever event finishes the turn) and not cleared either (clearing it would
// silently drop the model's in-progress text instead of just deferring its commit).
function pushLine(state: TuiState, line: string, flush = true): TuiState {
  if (!flush) return appendLines(state, [line]);
  const appended = state.streaming.length > 0 ? [state.streaming, line] : [line];
  return { ...appendLines(state, appended), streaming: "" };
}

// Appends one or more LOGICAL lines, untouched — no wrapping here; see TuiState.transcript's own
// comment for why the entries themselves must stay whatever was passed in. `addedRows` (the VISUAL
// row count the new lines add at the current `columns`, not `rawLines.length`) does two things:
// advances `totalVisualRows` (the cache `transcript-scroll`'s own clamp trusts — see that field's
// own comment) unconditionally, since it must stay correct regardless of scroll position; and, only
// while the viewport is scrolled up (`transcriptScrollOffset > 0`), advances the offset by the same
// amount so a scrolled-up view stays anchored on the same content as new rows arrive, rather than
// sliding out from under the reader mid-read by fewer rows than what actually landed underneath it.
function appendLines(state: TuiState, rawLines: string[]): TuiState {
  const addedRows = transcriptVisualRows(rawLines, state.columns);
  return {
    ...state,
    transcript: [...state.transcript, ...rawLines],
    totalVisualRows: state.totalVisualRows + addedRows,
    transcriptScrollOffset:
      state.transcriptScrollOffset > 0 ? state.transcriptScrollOffset + addedRows : 0,
  };
}

function applyLoopEvent(state: TuiState, event: LoopEvent): TuiState {
  switch (event.type) {
    case "text-delta":
      return { ...state, streaming: state.streaming + event.text };
    case "tool-call":
      return {
        ...pushLine(state, `→ ${event.name}(${JSON.stringify(event.args)})`),
        status: `Running ${event.name}…`,
        pendingTool:
          event.name === "write_file" || event.name === "edit"
            ? { name: event.name, args: event.args }
            : state.pendingTool,
      };
    // Finding 7: toolResultLine/toolAllowedLine (cli/output.ts), not a hand-copied line shape —
    // this had drifted from printEvent's own rendering (missing the edit-specific message and the
    // verification suffix here, missing escapeControlChars on tool-allowed's name) before sharing
    // the same two functions closed that gap for good.
    case "tool-result":
      return { ...pushLine(state, toolResultLine(event)), status: "", pendingTool: undefined };
    case "permission-denied":
      return { ...pushLine(state, `✗ ${event.name} blocked`), status: "", pendingTool: undefined };
    case "tool-allowed":
      return {
        ...pushLine(state, toolAllowedLine(event.name)),
        status: "",
      };
    case "compacted":
      return pushLine(state, `⚙ compacted ${event.evictedCount} messages`);
    case "retry":
      return pushLine(state, `↻ rate-limited or unavailable; retrying (attempt ${event.attempt})`);
    // Deliberately a no-op here, same as printEvent (cli/output.ts): the loop emits one `usage`
    // per completed model call, which would put a token count between every turn.
    case "usage":
      return state;
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
    case "error":
      return { ...pushLine(state, event.error), status: "", pendingTool: undefined };
    default: {
      const _unhandled: never = event;
      return state;
    }
  }
}
