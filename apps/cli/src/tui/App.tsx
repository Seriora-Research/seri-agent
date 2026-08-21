// Root TUI component, rendered full-screen in the alternate screen buffer (altScreen.ts's own
// enter/exit calls, cli.ts). The transcript is a measured, tail-anchored, scrollable viewport
// (visibleTranscript, format.ts) rather than an append-only <Static> region — a terminal-width- and
// -height-bounded slice of `state.transcript` PLUS the in-progress `state.streaming` answer as its
// own newest entry, following the newest row by default and scrollable with PageUp/PageDown/Home/
// End. Everything below it is a live region: status/spinner, a pending-write placeholder, the mode
// indicator, and a basic input box, all re-rendered in place.

import type { ModelProvider } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import {
  Box,
  type DOMElement,
  Text,
  useApp,
  useBoxMetrics,
  useInput,
  useStdout,
  useWindowSize,
} from "ink";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import stringWidth from "string-width";
import { truncateArgsDisplay } from "../cli/output";
import type { ApprovalAnswer } from "../loop/loop";
import type { ResolvedRoute } from "../provider/routing";
import type { SessionState } from "../session/session";
import { ErrorLine } from "./components";
import {
  DEFAULT_COLUMNS,
  FALLBACK_CHROME_ROWS,
  formatModeLabel,
  type VisibleRow,
  visibleTranscript,
  wrapPendingRows,
} from "./format";
import { ApprovalBox } from "./panels/ApprovalBox";
import { AuthBanner, AuthPanel } from "./panels/AuthPanel";
import { ConfigPanel } from "./panels/ConfigPanel";
import { InputBox } from "./panels/InputBox";
import { ModelPicker } from "./panels/ModelPicker";
import { PermissionsPanel } from "./panels/PermissionsPanel";
import { SetupPanel } from "./panels/SetupPanel";
import { WelcomeSplash } from "./panels/WelcomeSplash";
import { type Dispatch, initialTuiState, tuiReducer } from "./reducer";
import { theme } from "./theme";

export type AppProps = {
  session: SessionState<ModelMessage>;
  // Seeds the reducer's own `state.route` at mount (`initialTuiState(session, { route })`, below)
  // — the persistent mode-indicator's model+route label reads `state.route`, not this prop
  // directly, so a later /model switch reaches the label by dispatching `route-updated` into the
  // reducer instead of this prop ever changing. The key itself is required, not optional: making
  // it optional would let a future call site silently omit it instead of failing to compile
  // (code-review finding: this is exactly what let the OTHER `createElement(App, ...)` call site,
  // cli.ts's `finishQuit` re-render, go unnoticed). The VALUE is `| undefined` because a third call
  // site (runGuidedSetup, cli.ts) mounts App before any provider key exists at all — genuinely no
  // PreparedRun/route to pass (found 2026-08-13: PR #86 made this required assuming only 2 call
  // sites existed, both post-PreparedRun; PR #87 had already added this third one on a branch that
  // predated #86's route requirement, so neither PR could see the conflict at review time).
  // formatModeLabel drops the model+route suffix entirely when `state.route` is undefined, rather
  // than showing a fabricated route ("your key" during a flow where there is provably no key yet
  // would be actively wrong, not just a placeholder).
  route: ResolvedRoute | undefined;
  // The seam Phase 5 wires driveLoop's dispatch through: called once on mount with the reducer's
  // own dispatch function, the same shape `useReducer` returns. Optional because Phase 4's tests
  // exercise the reducer via `connectDispatch` directly, with no live loop behind it yet.
  connectDispatch?: (dispatch: Dispatch) => void;
  // Submitted line from the input box — Phase 5 wires this to the task/slash-command dispatch;
  // Phase 4 has nowhere real to send it yet.
  onSubmit?: (value: string) => void;
  // Called on a raw Ctrl-C keypress — the TUI's own route into signals.ts's cancel slot, mirroring
  // cli.ts's readline path (`rl.on("SIGINT", () => deliverSignal("SIGINT"))`). Needed because raw
  // mode (which both Ink and readline use) never lets the terminal driver turn 0x03 into a real
  // process SIGINT — the byte arrives as ordinary input instead, so whatever is reading input has
  // to recognise it explicitly. The caller (runTui's render() call) turns off Ink's own default
  // `exitOnCtrlC` behavior specifically so this is the only thing a Ctrl-C here does — leaving
  // Ink's default on would give Ink its own competing exit path that races the one driveLoop's
  // AbortController expects.
  onCancel?: () => void;
  // Called whenever the reducer's own `state.session` changes — a mode cycle, a rewind, or the
  // loop-event reducer's own messages-updated merge. This is now the single source of truth for
  // persistence on the TUI path (a real bug this fixes: driveLoop used to persist a session it had
  // captured once at the start of a turn, so the very next messages-updated write silently
  // reverted a mid-run /mode both on disk and, before this, in the reducer too). Not gated to skip
  // the initial mount call — prepareSession already saved that exact session to disk, so the first
  // call here is a harmless, idempotent rewrite of the same content, not a bug worth guarding.
  onSessionChange?: (session: SessionState<ModelMessage>) => void;
  // HIGH-1: the TUI's own graceful-quit trigger, called on /exit (onSubmit intercepts it before
  // the ordinary command dispatch — see runTui's own comment) and on Ctrl-D at the input box (the
  // normal Unix "end input" convention). runTui's implementation re-renders with done: true (the
  // hook below) and resolves its own outer promise once Ink has actually unmounted, which is what
  // lets run() reach printUsage/the exit-code logic at all on the TUI path — before this existed
  // there was no way to reach it.
  onQuit?: () => void;
  // True once runTui's own quit() has fired. Ink does not auto-exit on its own — Phase 1's own
  // hello-world smoke test hung until an explicit unmount()/exit() call was added — so this effect
  // is what ends the process, rather than relying on implicit auto-exit-on-unmount (also the
  // documented workaround for a macOS-only Bun/Ink cosmetic issue: cursor invisible after exit).
  done: boolean;
  // Findings 1+5 (thermo-nuclear structural review, round 6): answers the TUI-native approval
  // prompt (runTui's own tuiApprovalPrompt, cli.ts) — the ORIGINAL research-spec design ("a TUI
  // supplies a different function of the identical signature... with zero change to
  // loop.ts/gate.ts") that every earlier round of this branch left unbuilt, leaving the TUI path
  // calling makeApprovalPrompt's readline-based prompt instead: a SECOND stdin consumer and a
  // SECOND SIGINT route racing Ink's own raw-mode ownership and signals.ts's single cancel slot.
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
  // /setup's own five resolutions (D5-D8, feature-plan.md) — mirroring onModelSelected's shape:
  // each does nothing but call into cli.ts's own handlers, which recompute the whole next
  // SetupState (rows included) and dispatch it, the same "presentation calls a prop, cli.ts owns
  // the decision" split every other interactive command in this file already has.
  onSetupSelect?: (provider: ModelProvider) => void;
  onSetupKeyEntered?: (provider: ModelProvider, value: string) => void;
  onSetupRemove?: (provider: ModelProvider) => void;
  onSetupBack?: () => void;
  onSetupClose?: (leftoverInput?: string) => void;
  // Bug fix (coordinator follow-up on Stage C; extended round 4): AuthPanel's own "result" step
  // (a device-flow failure — a denied/expired code, a network error, degraded by
  // createAuthHandlers' (tui/handlers.ts) own catch block) had no way back to InputBox at all
  // before this — not even Ctrl-C, which is wired to onCancel, not to clearing pendingAuth. Called
  // from AuthPanel's own Escape handler on every step, plus Enter on "result" — a successful login
  // never reaches here: createAuthHandlers.onLogin (tui/handlers.ts) dispatches auth-resolved
  // itself, right after its own `await loginFn(...)` returns, with no user keypress involved.
  onAuthResolved?: () => void;
  // Stage A scaffolding (cli-commands-to-tui feature-plan.md): /config's own resolutions, mirroring
  // onSetupSelect's own five-prop shape — ConfigPanel.tsx's own step-dispatcher needs a real prop to
  // route Esc/Ctrl-D/Enter to once Stage D wires config-requested, rather than a panel silently
  // stranding the user with no way back to InputBox. Optional, matching every other handler prop on
  // this type (onSetupSelect included) — cli.ts's two mount sites and guidedSetup.ts's mount site
  // each already supply only the subset of handlers their own mount actually uses, so making these
  // two required would force edits to all three, outside this stage's own stated file boundary
  // (cli.ts/guidedSetup.ts are explicitly not touched in Stage A). Unreachable today: nothing
  // dispatches config-requested/permissions-requested yet.
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

// A pty can genuinely report `stdout.columns` as a real but unusable `0` for the first render or
// two, before its window-size ioctl has actually landed (reproduced live over a real pty in WSL):
// `state.columns` reaching `wrapForTranscript` as 0 clamps to 1 there — not a crash, but a
// transcript wrapped to ONE CHARACTER PER ROW, which is worse than the silent corruption that
// clamp was written to prevent. `|| DEFAULT_COLUMNS`, not `??`: `||` treats `0`
// the same as `undefined`/`null`, which is exactly the substitution a column count of zero needs —
// there is no real terminal width `0` is ever the correct value for.
function resolveWidth(columns: number | undefined): number {
  return columns || DEFAULT_COLUMNS;
}

// D5 (byok-open3-route-indicator feature-plan.md): no such hook existed in this file before — the
// persistent mode-indicator (App, below) needs to know the terminal's current column width, live,
// to pick its 3-tier layout. See DEFAULT_COLUMNS's own comment for what the fallback actually
// guards (a genuine non-TTY production stdout, or the real pty startup race above), and what it
// does not.
function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(resolveWidth(stdout.columns));

  useEffect(() => {
    const onResize = () => setWidth(resolveWidth(stdout.columns));
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return width;
}

// One visibleTranscript row's own render props — factored out, not inlined into the JSX below, for
// the same reason ListRow (components.tsx) is: ink-testing-library's `lastFrame()` carries no ANSI
// in this test environment, so `backgroundColor` is otherwise invisible to a mounted-frame
// assertion; calling this directly lets a test pin the actual prop instead of the frame text.
export function transcriptRowProps(
  row: VisibleRow,
  bandWidth: number,
): { text: string; backgroundColor: string | undefined } {
  if (row.role !== "user") return { text: row.text, backgroundColor: undefined };
  // `padEnd` counts UTF-16 units, not terminal cells — a CJK/wide-char row would overpad past
  // `bandWidth`. `stringWidth` measures display width instead (same measure `wrap-ansi` already
  // uses to wrap this same text upstream).
  const padding = " ".repeat(Math.max(0, bandWidth - stringWidth(row.text)));
  return { text: row.text + padding, backgroundColor: theme.userBg };
}

// The user-message band's own width — the widest currently visible role:"user" row, clamped to
// `columns` (visibleTranscript already wraps every row to at most `columns` wide, so this only
// guards a stale-columns edge case, not the common one). A uniform band across all visible user
// rows reads as one band; padding each row to only its own width (the cheaper option) would
// instead read as a ragged per-message highlight. Factored out, same reason as
// `transcriptRowProps` above: a test can pin this directly instead of only the padding it feeds.
export function computeBandWidth(visibleRows: VisibleRow[], columns: number): number {
  return Math.min(
    columns,
    visibleRows.reduce(
      (widest, row) => (row.role === "user" ? Math.max(widest, stringWidth(row.text)) : widest),
      0,
    ),
  );
}

export function App({
  session,
  route,
  connectDispatch,
  onSubmit,
  onCancel,
  onSessionChange,
  onQuit,
  done,
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
  const { exit } = useApp();
  const width = useTerminalWidth();
  const { rows } = useWindowSize();
  const modeLabel = formatModeLabel(state.modeIndicator, state.route, width);

  // The transcript viewport's own height comes from flexbox's leftover space (flexGrow, below),
  // not from how many lines it renders — so measuring it back with useBoxMetrics cannot create a
  // feedback loop where changing the slice changes the measurement. `hasMeasured` is false only for
  // the one frame before Ink's first layout pass; FALLBACK_CHROME_ROWS is a placeholder for that
  // frame alone, not a real chrome-height estimate.
  const viewportRef = useRef<DOMElement | null>(null);
  const { height: measuredRows, hasMeasured } = useBoxMetrics(viewportRef);
  // `Math.max(1, ...)` on BOTH branches: the measured one had no floor. The
  // transcript Box has `minHeight={0}`, so on a short enough terminal — or one where the sibling
  // rows above/below it (mode indicator, an open commandError line) already consume the whole
  // `rows - 1` budget — Yoga can genuinely measure it down to 0. `visibleTranscript(transcript, 0,
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
    if (done) exit();
  }, [done, exit]);

  useEffect(() => {
    onSessionChange?.(state.session);
  }, [state.session, onSessionChange]);

  // True exactly when InputBox is the render ternary's own active branch, below — every other
  // branch is a modal panel that owns the keyboard. The transcript Box above (flexGrow/minHeight={0})
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

  // A second, independent useInput from InputBox's own — Ink delivers the same keypress to every
  // registered handler, so this fires regardless of what InputBox does with the same press (today,
  // nothing: InputBox's own handler skips any key.ctrl input).
  useInput((input, key) => {
    if (key.ctrl && input === "c") onCancel?.();
    if (!noPanelOpen) return;
    if (key.pageUp) dispatch({ type: "transcript-scroll", delta: pageSize });
    if (key.pageDown) dispatch({ type: "transcript-scroll", delta: -pageSize });
    if (key.home) dispatch({ type: "transcript-scroll-to", to: "top" });
    if (key.end) dispatch({ type: "transcript-scroll-to", to: "bottom" });
  });

  const visibleRows = visibleTranscript(
    state.transcript,
    viewportRows,
    transcriptOffset,
    state.columns,
    memoizedPending,
  );
  const bandWidth = computeBandWidth(visibleRows, state.columns);

  return (
    // `rows - 1`, not `rows`, on every platform, not just a Windows-only gate: Windows' own
    // `isWindowsConsole && (wasFullscreen || isFullscreen)` full-redraw path
    // (Ink's own resolveOutput) is real and Windows-specific, but it is not the only reason this
    // needs to stay one row short. At a FULL `rows`, `isFullscreen` becomes true on every platform
    // (Ink's own `outputHeight >= viewportRows`), and mid-run `console.*` output (patchConsole,
    // e.g. a checkpoint/archivist warning) then erases and rewrites `rows` lines for a write that
    // adds its own lines on top — the terminal scrolls, but nothing off Windows re-triggers the
    // full-clear path to notice, so log-update's own line-count bookkeeping goes stale and every
    // later frame paints at the wrong offset for the REST OF THE SESSION. `rows - 1` leaves exactly
    // the one spare row that absorbs a single console write without ever scrolling the viewport.
    <Box flexDirection="column" height={rows - 1}>
      {/* Rendered ABOVE the render ternary below, not as one of its branches — unlike
      ApprovalBox/ModelPicker/SetupPanel this never replaces InputBox, it sits alongside it.
      `state.pendingAuth === undefined` (not just `state.authOffer`) is the derived half of the
      fix (thermo-nuclear + code-review, round 4): `authOffer` alone used to need a matching
      `auth-offer: false` dispatch at every point the auth panel opened, and round 2's whole bug
      class was a call site that forgot one. The reducer already owns `pendingAuth` — "is the
      panel currently open" is exactly what should gate "hide the redundant banner," derived here
      instead of commanded from cli.ts. `!state.pendingSplash`: the splash mount's own login/signup
      menu already offers the same thing, so the banner would otherwise render underneath it. */}
      <AuthBanner
        show={state.authOffer && state.pendingAuth === undefined && !state.pendingSplash}
      />
      {/* flexGrow/flexShrink/minHeight={0} give this box whatever height is left over after
      every sibling below has laid out — `viewportRows` (above) reads that back via useBoxMetrics,
      not the other way around, so there is no feedback loop from the slice into the measurement.
      `visibleTranscript` (format.ts) already wraps every entry to `state.columns` and caps the
      VISUAL row count at `viewportRows`, so `overflowY`/`justifyContent="flex-end"` are a pure
      backstop now, not load-bearing truncation — anchoring to the end means a genuine one-frame
      overshoot falls off the top (oldest), not the bottom (newest).
      The in-progress answer (`state.streaming`, wrapped via `memoizedPending` above) is passed as
      `visibleTranscript`'s own `pendingRows` parameter rather than rendered as its own unbounded
      `<Text>` below the box (the original shape) or spread into a `[...state.transcript,
      state.streaming]` array (tried and reverted: that allocated a full copy of the transcript on
      every streamed token, exactly what `visibleTranscript`'s own tail-walk exists to avoid paying).
      `effectiveOffset` below is what keeps a scrolled-up reader's view from drifting toward newer
      content as the answer grows and then snapping back the instant it flushes: `appendLines`
      (reducer.ts) already advances `transcriptScrollOffset` by a flush's own row count for exactly
      this reason, and pending rows need the identical treatment applied live, since they are not
      yet a dispatched action `appendLines` could react to. */}
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        overflowY="hidden"
        justifyContent={isShort ? "flex-start" : "flex-end"}
      >
        {visibleRows.map((row, index) => {
          const { text, backgroundColor } = transcriptRowProps(row, bandWidth);
          return (
            <Text key={index} backgroundColor={backgroundColor}>
              {text}
            </Text>
          );
        })}
      </Box>
      {state.pendingTool !== undefined && (
        <Box borderStyle="single" borderColor={theme.warning}>
          {/* truncateArgsDisplay (cli/output.ts), not a raw JSON.stringify: pendingTool is set
          ONLY for write_file/edit (reducer.ts), the two tools whose args carry a whole file body —
          exactly the case the helper exists for, uncapped here otherwise. */}
          <Text color={theme.warning}>
            {`${state.pendingTool.name}(${truncateArgsDisplay(state.pendingTool.args)})`}
          </Text>
        </Box>
      )}
      <Box flexDirection="row" justifyContent="space-between">
        <Text>{modeLabel}</Text>
        <Box flexDirection="row" gap={1}>
          {/* `noPanelOpen` too, not just the offset: while a panel is open, End
          is swallowed by the exact same gate `noPanelOpen` already puts on the transcript-scroll
          keys above — the banner would otherwise keep telling the user to press a key that does
          nothing until they close the panel first. */}
          {state.transcriptScrollOffset > 0 && noPanelOpen && (
            <Text color={theme.muted}>↑ scrolled — End to follow</Text>
          )}
          {state.status.length > 0 && <Text color={theme.muted}>{state.status}</Text>}
        </Box>
      </Box>
      <ErrorLine message={state.commandError} />
      {/* Findings 1+5: mutually exclusive with InputBox — a pending approval question is the only
      thing this run is waiting on, and answering it (not typing a task or slash command) is the
      only input that means anything until it clears. Extended to a third state for /model, a
      fourth for /setup, and now (Stage A scaffolding) three more for /login /signup, /config and
      /permissions: each is the same kind of "only this input means anything right now" question,
      checked in this same order (approval, /model, /setup, /login /signup, /config, /permissions,
      then InputBox). The last three are unreachable today — nothing dispatches
      auth-requested/config-requested/permissions-requested yet (Stages C-D wire that). */}
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
        <WelcomeSplash
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
    </Box>
  );
}
