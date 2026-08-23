/** @jsxImportSource @opentui/react */
// Root TUI component, rendered inside the one `CliRenderer` shared by `routes/setup/
// welcomeSplash.ts`, `routes/setup/guidedSetup.ts`, and `cli.ts`'s `runTui` (`runtime/renderer.ts`,
// `screenMode: "alternate-screen"`) — each phase `root.render`s different props into the same
// instance rather than mounting its own. The transcript is a measured, tail-anchored, scrollable
// viewport (visibleTranscript, util/format.ts) rather than an append-only region — a
// terminal-width- and -height-bounded slice of `state.transcript` PLUS the in-progress
// `state.streaming` answer as its own newest entry, following the newest row by default and
// scrollable with PageUp/PageDown/Home/End. Everything below it is a live region: status/spinner, a
// pending-write placeholder, the mode indicator, and a basic input box, all re-rendered in place.
//
// Renderer lifecycle (mount, unmount, alt-screen entry/exit) is NOT this component's concern —
// unlike Ink, where `App` itself called `useApp().exit()` on a `done` prop, OpenTUI has no such
// hook: the three callers above own the `CliRenderer` directly and destroy it themselves once a
// quit is ready to complete (`getTuiRenderer`/`destroyTuiRenderer`, runtime/renderer.ts).
import type { BoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ModelProvider } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { useEffect, useMemo, useReducer, useState } from "react";
import { truncateArgsDisplay } from "../cli/output";
import type { ApprovalAnswer } from "../loop/loop";
import type { ResolvedRoute } from "../provider/routing";
import type { SessionState } from "../session/session";
import { ApprovalBox } from "./components/ApprovalBox";
import { InputBox } from "./components/InputBox";
import { ModelPicker } from "./components/ModelPicker";
import { TurnStatus } from "./components/TurnStatus";
import { AuthBanner, AuthPanel } from "./routes/config/AuthPanel";
import { ConfigPanel } from "./routes/config/ConfigPanel";
import { PermissionsPanel } from "./routes/config/PermissionsPanel";
import { SetupPanel } from "./routes/setup/SetupPanel";
import { WelcomeSplashPanel } from "./routes/setup/WelcomeSplashPanel";
import { type Dispatch, initialTuiState, tuiReducer } from "./state/reducer";
import { theme } from "./theme/theme";
import { ErrorLine } from "./ui/ErrorLine";
import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  FALLBACK_CHROME_ROWS,
  formatModeLabel,
  transcriptRowsProps,
  visibleTranscript,
  wrapPendingRows,
} from "./util/format";

export type AppProps = {
  session: SessionState<ModelMessage>;
  // Seeds the reducer's own `state.route` at mount (`initialTuiState(session, { route })`, below)
  // — the persistent mode-indicator's model+route label reads `state.route`, not this prop
  // directly, so a later /model switch reaches the label by dispatching `route-updated` into the
  // reducer instead of this prop ever changing. The key itself is required, not optional: making it
  // optional would let a future `createElement(App, ...)` call site silently omit it instead of
  // failing to compile. The VALUE is `| undefined` because one call site (runGuidedSetup, cli.ts)
  // mounts App before any provider key exists at all — genuinely no PreparedRun/route to pass.
  // formatModeLabel drops the model+route suffix entirely when `state.route` is undefined, rather
  // than showing a fabricated route ("your key" during a flow where there is provably no key yet
  // would be actively wrong, not just a placeholder).
  route: ResolvedRoute | undefined;
  // The seam driveLoop's dispatch is wired through: called once on mount with the reducer's own
  // dispatch function, the same shape `useReducer` returns. Optional because some tests exercise
  // the reducer via `connectDispatch` directly, with no live loop behind it.
  connectDispatch?: (dispatch: Dispatch) => void;
  // Submitted line from the input box, wired to the task/slash-command dispatch.
  onSubmit?: (value: string) => void;
  // Called whenever the reducer's own `state.session` changes — a mode cycle, a rewind, or the
  // loop-event reducer's own messages-updated merge. This is now the single source of truth for
  // persistence on the TUI path (a real bug this fixes: driveLoop used to persist a session it had
  // captured once at the start of a turn, so the very next messages-updated write silently
  // reverted a mid-run /mode both on disk and, before this, in the reducer too). Not gated to skip
  // the initial mount call — prepareSession already saved that exact session to disk, so the first
  // call here is a harmless, idempotent rewrite of the same content, not a bug worth guarding.
  onSessionChange?: (session: SessionState<ModelMessage>) => void;
  // The TUI's own graceful-quit trigger, called on /exit (onSubmit intercepts it before the
  // ordinary command dispatch — see runTui's own comment) and on Ctrl-D at the input box (the
  // normal Unix "end input" convention). `cli.ts`'s `quit()` is what actually ends the renderer now
  // (this component no longer calls any exit hook itself — see this file's own header comment).
  onQuit?: () => void;
  // Answers the TUI-native approval prompt (runTui's own tuiApprovalPrompt, cli.ts) — a real prompt
  // rendered inside this same tree, not readline's own stdin-based prompt: a second stdin consumer
  // and a second SIGINT route would otherwise race the renderer's own raw-mode ownership and
  // signals.ts's single cancel slot.
  onApprovalAnswer?: (answer: ApprovalAnswer) => void;
  // /model's own two resolutions, mirroring onApprovalAnswer's shape: called from ModelPicker's own
  // keypress handler, wired by runTui to dispatch model-picker-resolved (with or without a pick)
  // into the SAME reducer everything else here already shares. `onModelSelected` takes just the
  // pick (model + provider), not a whole session — TuiAction's own "model-picker-resolved" comment
  // explains why a whole captured session is the race this stopped carrying.
  // `leftoverInput`: text typed after a terminator embedded in the same combined pty chunk that
  // resolved this pick — see `pendingInputPrefill`'s own comment (reducer.ts). Absent on the
  // ordinary single-Enter path.
  onModelSelected?: (
    pick: { model: string; provider: ModelProvider; keyConfigured: boolean },
    leftoverInput?: string,
  ) => void;
  onModelPickerCancel?: () => void;
  // /setup's own five resolutions, mirroring onModelSelected's shape: each does nothing but call
  // into cli.ts's own handlers, which recompute the whole next
  // SetupState (rows included) and dispatch it, the same "presentation calls a prop, cli.ts owns
  // the decision" split every other interactive command in this file already has.
  onSetupSelect?: (provider: ModelProvider) => void;
  onSetupKeyEntered?: (provider: ModelProvider, value: string) => void;
  onSetupRemove?: (provider: ModelProvider) => void;
  onSetupBack?: () => void;
  onSetupClose?: (leftoverInput?: string) => void;
  // AuthPanel's own "result" step (a device-flow failure — a denied/expired code, a network error,
  // degraded by createAuthHandlers' (tui/handlers.ts) own catch block) has no way back to InputBox
  // otherwise — not even Ctrl-C, which cancels the in-flight turn (runtime/renderer.ts), not
  // pendingAuth. Called from AuthPanel's own Escape handler on every step, plus Enter on "result" —
  // a successful login never reaches here: createAuthHandlers.onLogin (tui/handlers.ts) dispatches
  // auth-resolved itself, right after its own `await loginFn(...)` returns, with no user keypress
  // involved.
  onAuthResolved?: () => void;
  // /config's own resolutions, mirroring onSetupSelect's own five-prop shape — ConfigPanel.tsx's
  // own step-dispatcher routes Esc/Ctrl-D/Enter to these rather than silently stranding the user
  // with no way back to InputBox. Optional, matching every other handler prop on this type
  // (onSetupSelect included) — cli.ts's two mount sites and guidedSetup.ts's mount site each supply
  // only the subset of handlers their own mount actually uses.
  onConfigSelect?: (key: string) => void;
  onConfigValueEntered?: (key: string, value: string) => void;
  onConfigUnset?: (key: string) => void;
  onConfigBack?: () => void;
  onConfigClose?: (leftoverInput?: string) => void;
  // /permissions' own resolutions — one fewer than /config's (PermissionsPanel.tsx has no
  // value-entry step, so no onPermissionsSelect: 'r'/Delete on the list step calls
  // onPermissionsRemove directly, the same way SetupList's own 'r' calls onSetupRemove).
  onPermissionsRemove?: (tool: string) => void;
  onPermissionsBack?: () => void;
  onPermissionsClose?: (leftoverInput?: string) => void;
  // The welcome-splash mount's own three resolutions — unreachable in runTui/runGuidedSetup, whose
  // own initialTuiState calls never set pendingSplash (reducer.ts's own comment).
  onSplashLogin?: () => void;
  onSplashSignup?: () => void;
  onSplashContinue?: () => void;
};

// A pty can genuinely report a terminal width as a real but unusable `0` for the first render or
// two, before its window-size ioctl has actually landed (reproduced live over a real pty in WSL):
// `state.columns` reaching `wrapForTranscript` as 0 clamps to 1 there — not a crash, but a
// transcript wrapped to ONE CHARACTER PER ROW, which is worse than the silent corruption that
// clamp was written to prevent. `|| DEFAULT_COLUMNS`, not `??`: `||` treats `0`
// the same as `undefined`/`null`, which is exactly the substitution a column count of zero needs —
// there is no real terminal width `0` is ever the correct value for.
function resolveWidth(columns: number): number {
  return columns || DEFAULT_COLUMNS;
}

// Same fallback, same reason, for the other half of a pty's first-render dimensions report —
// `height={rows}` (below) with a genuine but unusable `0` rows would give the root box zero
// height instead of a blank first frame.
function resolveHeight(rows: number): number {
  return rows || DEFAULT_ROWS;
}

export function App({
  session,
  route,
  connectDispatch,
  onSubmit,
  onSessionChange,
  onQuit,
  onApprovalAnswer,
  onModelSelected,
  onModelPickerCancel,
  onSetupSelect,
  onSetupKeyEntered,
  onSetupRemove,
  onSetupBack,
  onSetupClose,
  onAuthResolved,
  onConfigSelect,
  onConfigValueEntered,
  onConfigUnset,
  onConfigBack,
  onConfigClose,
  onPermissionsRemove,
  onPermissionsBack,
  onPermissionsClose,
  onSplashLogin,
  onSplashSignup,
  onSplashContinue,
}: AppProps) {
  const [state, dispatch] = useReducer(tuiReducer, initialTuiState(session, { route }));
  const { width: rawWidth, height: rawRows } = useTerminalDimensions();
  const width = resolveWidth(rawWidth);
  const rows = resolveHeight(rawRows);
  const modeLabel = formatModeLabel(state.modeIndicator, state.route, width);

  // The transcript viewport's own height comes from flexbox's leftover space (flexGrow, below),
  // not from how many lines it renders — so measuring it back cannot create a feedback loop where
  // changing the slice changes the measurement. `hasMeasured` is false only for the frames before
  // OpenTUI's own layout pass has fired `onSizeChange` at least once; FALLBACK_CHROME_ROWS is a
  // placeholder for those frames alone, not a real chrome-height estimate. OpenTUI's own
  // `<scrollbox>` needs no measured-height read for a transcript fed its FULL content, but this
  // component instead keeps the reducer's existing windowed-slice contract (`transcriptScrollOffset`
  // et al, state/reducer.ts, unchanged) and uses `onSizeChange` (an event-driven per-renderable
  // option, not a polling hook) as the direct replacement for Ink's `useBoxMetrics` read.
  const [measuredRows, setMeasuredRows] = useState(0);
  const [hasMeasured, setHasMeasured] = useState(false);
  // `Math.max(1, ...)` on BOTH branches: the measured one had no floor. The
  // transcript box has `minHeight={0}`, so on a short enough terminal — or one where the sibling
  // rows above/below it (mode indicator, an open commandError line) already consume the whole
  // budget — Yoga can genuinely measure it down to 0. `visibleTranscript(transcript, 0,
  // ...)` then computes `start === end`, an empty slice: an in-progress streamed answer renders as
  // nothing, not as "not enough room," with no visible sign anything is wrong until the layout
  // recovers.
  const viewportRows = Math.max(1, hasMeasured ? measuredRows : rows - FALLBACK_CHROME_ROWS);
  // One line of overlap between pages, same convention a terminal pager's own PageUp/PageDown use.
  const pageSize = Math.max(1, viewportRows - 1);

  // Read the render-time `visibleTranscript` call's own comment for why this exists: a scrolled-up
  // `transcriptScrollOffset` (reducer.ts) only ever advances when a flush actually happens
  // (`appendLines`), so without this, a streamed answer's OWN growth (not yet flushed) would drift
  // the visible window toward newer content one row at a time and then snap back at flush. `[]` when
  // `state.streaming` is empty: `wrapPendingRows` always returns >= 1 row even for `""` (a blank
  // committed line is meaningful; an ABSENT streaming answer is not), so this guards that case
  // explicitly rather than let a spurious extra row of offset apply while nothing is streaming.
  //
  // Only the GROWTH since `transcriptScrollOffset` was last set is added, not the full current
  // `pendingRows`: `transcriptScrollOffset` itself already includes whatever streaming row count
  // existed at the moment a scroll action last set it (`maxScrollOffset`, reducer.ts, folds
  // `state.streaming`'s own row count into the ceiling it clamps against). Adding the CURRENT total
  // on top of that every render double-counts those already-baked-in rows — `transcriptOffset` then
  // overshoots the combined committed+streaming stack `visibleTranscript` slices, and the viewport
  // renders a gap instead of a full page. `transcriptScrollStreamingRows` is the reducer's own
  // snapshot of what was already baked in, so only the delta needs compensating for here.
  //
  // `useMemo`, keyed on `[state.streaming, state.columns]`: without it, `wrapPendingRows` re-wrapped
  // the entire, ever-growing streamed string from scratch on every render (this computation and the
  // `visibleTranscript` call below both needed it), rather than only when the streamed text or the
  // terminal width actually changed.
  const memoizedPending = useMemo(
    () => (state.streaming.length > 0 ? wrapPendingRows(state.streaming, state.columns) : []),
    [state.streaming, state.columns],
  );
  const pendingRows = memoizedPending.length;
  const transcriptOffset =
    state.transcriptScrollOffset > 0
      ? state.transcriptScrollOffset +
        Math.max(0, pendingRows - state.transcriptScrollStreamingRows)
      : 0;

  // A transcript shorter than the viewport top-anchors instead of tail-anchors: bottom-pinning a
  // half-empty screen (the default below, `flex-end`) reads as a mostly-blank terminal until the
  // session grows past `viewportRows`, rather than starting at the top the way a real terminal's
  // own scrollback does.
  const contentRows = state.totalVisualRows + pendingRows;
  const isShort = contentRows < viewportRows;

  // `columns`/`viewportRows` live on TuiState itself (reducer.ts's own comment on those fields) —
  // this is the one place that ever measures them, so it's the one place that ever dispatches them
  // in. Two things ride on this same action: `appendLines` (reducer.ts) needs the current width to
  // wrap new transcript content to real visual rows, and a resize that GROWS `viewportRows` with no
  // keypress at all needs `transcriptScrollOffset` re-clamped against the new max (the reducer's own
  // `viewport-resized` case does both) — useListWindow's own effect handles the identical resize
  // case for panel lists, just against component state instead of the reducer's.
  //
  // Declared before `connectDispatch`'s own effect, not after: on mount, React runs effects in
  // declaration order within the same commit, and cli.ts's `runTui` dispatches the initial task
  // echo and any queued startup notices from INSIDE that later effect (connectDispatch's own
  // callback) — this one has to land first so `state.columns` is already the real measured width
  // by the time anything gets wrapped, not the placeholder `initialTuiState` seeds it with.
  useEffect(() => {
    dispatch({ type: "viewport-resized", columns: width, viewportRows });
  }, [width, viewportRows]);

  useEffect(() => {
    connectDispatch?.(dispatch);
  }, [connectDispatch]);

  useEffect(() => {
    onSessionChange?.(state.session);
  }, [state.session, onSessionChange]);

  // True exactly when InputBox is the render ternary's own active branch, below — every other
  // branch is a modal panel that owns the keyboard. The transcript box above (flexGrow/minHeight={0})
  // still renders unconditionally regardless of which branch is active, so on a terminal taller
  // than the open panel's own content it stays partially visible above it, not fully occluded — but
  // PageUp/PageDown/Home/End must still not scroll it in the background while a panel is open: the
  // user would close the panel to find the transcript scrolled and the "↑ scrolled" banner showing,
  // with no visible keypress of theirs against the transcript to explain why.
  const noPanelOpen =
    state.pendingApproval === undefined &&
    state.pendingModelPicker === undefined &&
    state.pendingSetup === undefined &&
    state.pendingAuth === undefined &&
    state.pendingConfig === undefined &&
    state.pendingPermissions === undefined &&
    !state.pendingSplash;

  // A second, independent useKeyboard from InputBox's own — OpenTUI delivers the same keypress to
  // every registered handler, so this fires regardless of what InputBox does with the same press
  // (today, nothing: InputBox's own handler skips any key.ctrl input). Ctrl-C itself is NOT handled
  // here — `runtime/renderer.ts`'s own registration owns that, see its comment for why.
  useKeyboard((key) => {
    if (!noPanelOpen) return;
    if (key.name === "pageup") dispatch({ type: "transcript-scroll", delta: pageSize });
    if (key.name === "pagedown") dispatch({ type: "transcript-scroll", delta: -pageSize });
    if (key.name === "home") dispatch({ type: "transcript-scroll-to", to: "top" });
    if (key.name === "end") dispatch({ type: "transcript-scroll-to", to: "bottom" });
  });

  const visibleRows = visibleTranscript(
    state.transcript,
    viewportRows,
    transcriptOffset,
    state.columns,
    memoizedPending,
  );
  const rowProps = transcriptRowsProps(visibleRows);

  return (
    // No `height - 1` spare-row workaround: that existed only for Ink's own console-patching
    // full-redraw path (`resolveOutput`'s `isFullscreen` check racing `log-update`'s line-count
    // bookkeeping on a mid-run `console.*` write) — OpenTUI is a native terminal renderer with its
    // own buffer/diffing, not a diff-and-reprint-over-stdout library, so there is no equivalent
    // "console write scrolls the viewport out from under the redraw bookkeeping" failure mode to
    // guard against. Full terminal height is used directly.
    <box flexDirection="column" height={rows}>
      {/* Rendered ABOVE the render ternary below, not as one of its branches — unlike
      ApprovalBox/ModelPicker/SetupPanel this never replaces InputBox, it sits alongside it.
      `state.pendingAuth === undefined` (not just `state.authOffer`) avoids needing a matching
      `auth-offer: false` dispatch at every point the auth panel opens — a call site that forgets
      one is a real bug class this closes by construction. The reducer already owns `pendingAuth` —
      "is the panel currently open" is exactly what should gate "hide the redundant banner," derived
      here instead of commanded from cli.ts. `!state.pendingSplash`: the splash mount's own
      login/signup menu already offers the same thing, so the banner would otherwise render
      underneath it. */}
      <AuthBanner
        show={state.authOffer && state.pendingAuth === undefined && !state.pendingSplash}
      />
      {/* flexGrow/flexShrink/minHeight={0} give this box whatever height is left over after
      every sibling below has laid out — `viewportRows` (above) reads that back via `onSizeChange`,
      not the other way around, so there is no feedback loop from the slice into the measurement.
      `visibleTranscript` (util/format.ts) already wraps every entry to `state.columns` and caps the
      VISUAL row count at `viewportRows`, so `overflow="hidden"`/`justifyContent="flex-end"` are a
      pure backstop now, not load-bearing truncation — anchoring to the end means a genuine
      one-frame overshoot falls off the top (oldest), not the bottom (newest).
      The in-progress answer (`state.streaming`, wrapped via `memoizedPending` above) is passed as
      `visibleTranscript`'s own `pendingRows` parameter rather than rendered as its own unbounded
      `<text>` below the box (the original Ink shape) or spread into a `[...state.transcript,
      state.streaming]` array (tried and reverted there: that allocated a full copy of the
      transcript on every streamed token, exactly what `visibleTranscript`'s own tail-walk exists
      to avoid paying). `effectiveOffset` below is what keeps a scrolled-up reader's view from
      drifting toward newer content as the answer grows and then snapping back the instant it
      flushes: `appendLines` (state/reducer.ts) already advances `transcriptScrollOffset` by a
      flush's own row count for exactly this reason, and pending rows need the identical treatment
      applied live, since they are not yet a dispatched action `appendLines` could react to. */}
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        justifyContent={isShort ? "flex-start" : "flex-end"}
        onSizeChange={function onSizeChange(this: BoxRenderable) {
          setMeasuredRows(this.height);
          setHasMeasured(true);
        }}
      >
        {rowProps.map(({ text, backgroundColor }, index) => (
          <text key={index} bg={backgroundColor}>
            {text}
          </text>
        ))}
      </box>
      {state.pendingTool !== undefined && (
        <box borderStyle="single" borderColor={theme.warning}>
          {/* truncateArgsDisplay (cli/output.ts), not a raw JSON.stringify: pendingTool is set
          ONLY for write_file/edit (reducer.ts), the two tools whose args carry a whole file body —
          exactly the case the helper exists for, uncapped here otherwise. */}
          <text fg={theme.warning}>
            {`${state.pendingTool.name}(${truncateArgsDisplay(state.pendingTool.args)})`}
          </text>
        </box>
      )}
      <box flexDirection="row" justifyContent="space-between">
        <text>{modeLabel}</text>
        <box flexDirection="row" gap={1}>
          {/* `noPanelOpen` too, not just the offset: while a panel is open, End
          is swallowed by the exact same gate `noPanelOpen` already puts on the transcript-scroll
          keys above — the banner would otherwise keep telling the user to press a key that does
          nothing until they close the panel first. */}
          {state.transcriptScrollOffset > 0 && noPanelOpen && (
            <text fg={theme.muted}>↑ scrolled — End to follow</text>
          )}
          {state.status.length > 0 && <text fg={theme.muted}>{state.status}</text>}
          <TurnStatus turnStartedAt={state.turnStartedAt} tokenProgress={state.tokenProgress} />
        </box>
      </box>
      <ErrorLine message={state.commandError} />
      {/* Mutually exclusive with InputBox — a pending approval question is the only thing this run
      is waiting on, and answering it (not typing a task or slash command) is the only input that
      means anything until it clears. Extended to a third state for /model, a fourth for /setup,
      and three more for /login /signup, /config and /permissions: each is the same kind of "only
      this input means anything right now" question, checked in this same order (approval, /model,
      /setup, /login /signup, /config, /permissions, then InputBox). Every branch here — including
      AuthPanel/ConfigPanel/PermissionsPanel — is a real, wired OpenTUI component; state/handlers.ts
      and cli.ts dispatch auth-requested/config-requested/permissions-requested. */}
      {state.pendingApproval !== undefined ? (
        <ApprovalBox
          pendingApproval={state.pendingApproval}
          onAnswer={onApprovalAnswer}
          onQuit={onQuit}
        />
      ) : state.pendingModelPicker !== undefined ? (
        <ModelPicker
          entries={state.pendingModelPicker.entries}
          onModelSelected={onModelSelected}
          onModelPickerCancel={onModelPickerCancel}
        />
      ) : state.pendingSetup !== undefined ? (
        <SetupPanel
          pendingSetup={state.pendingSetup}
          onSetupSelect={onSetupSelect}
          onSetupKeyEntered={onSetupKeyEntered}
          onSetupRemove={onSetupRemove}
          onSetupBack={onSetupBack}
          onSetupClose={onSetupClose}
        />
      ) : state.pendingAuth !== undefined ? (
        <AuthPanel state={state.pendingAuth} onDismiss={onAuthResolved} />
      ) : state.pendingConfig !== undefined ? (
        <ConfigPanel
          pendingConfig={state.pendingConfig}
          onConfigSelect={onConfigSelect}
          onConfigValueEntered={onConfigValueEntered}
          onConfigUnset={onConfigUnset}
          onConfigBack={onConfigBack}
          onConfigClose={onConfigClose}
        />
      ) : state.pendingPermissions !== undefined ? (
        <PermissionsPanel
          pendingPermissions={state.pendingPermissions}
          onPermissionsRemove={onPermissionsRemove}
          onPermissionsBack={onPermissionsBack}
          onPermissionsClose={onPermissionsClose}
        />
      ) : state.pendingSplash ? (
        <WelcomeSplashPanel
          authenticated={!state.authOffer}
          onLogin={onSplashLogin}
          onSignup={onSplashSignup}
          onContinue={onSplashContinue}
        />
      ) : (
        <InputBox
          onSubmit={onSubmit}
          onQuit={onQuit}
          prefill={state.pendingInputPrefill}
          onPrefillConsumed={() => dispatch({ type: "input-prefill-consumed" })}
        />
      )}
    </box>
  );
}
