/** @jsxImportSource @opentui/react */
// Root TUI component, rendered inside the one `CliRenderer` shared by `routes/setup/
// welcomeSplash.ts`, `routes/setup/guidedSetup.ts`, and `cli.ts`'s `runTui` (`runtime/renderer.ts`,
// `screenMode: "alternate-screen"`) — each phase `root.render`s different props into the same
// instance rather than mounting its own. The transcript is a native `<scrollbox>` fed the FULL,
// unwindowed `state.transcript` — `stickyScroll`/`stickyStart="bottom"` (below) follow newly
// appended content while at the bottom, and hold position when scrolled away from it, natively
// (OpenTUI's own Yoga layout + scroll-anchor logic, not a reducer-computed slice). No mid-generation
// text is ever rendered in it: `state.streaming` accumulates every `text-delta` for `pushLine`'s
// next flush (state/reducer.ts), but is never itself displayed live, character by character — while
// a turn is active, `TurnStatus` (below) stays mounted for the whole turn as a fixed row OUTSIDE
// the scrollbox, directly beneath it — it never unmounts mid-turn, and it stays visible regardless
// of scroll position, since a child scrolled out of view is exactly what a native scrollbox would
// otherwise do to it. Each finished segment of the answer (the run of `text-delta`s up to whatever
// the model does next — a tool call, a tool result, or the turn's own end) commits atomically as a
// normal transcript entry the moment `pushLine` flushes it, landing at the scrollbox's own tail,
// directly above wherever `TurnStatus` is now pinned. Everything below the transcript box is a live
// region: status/spinner, a pending-write placeholder, the mode indicator, and a basic input box,
// all re-rendered in place.
//
// `<scrollbox>` itself is given a MEASURED, definite `height` (below), not `flexGrow`/a percentage:
// a `<scrollbox>` sized only by `flexGrow` (correct for a plain `<box>`, and what an early draft of
// this migration used) renders correctly on its own but corrupts sibling rows below it — cells the
// mode-indicator/panel rows should own end up carrying stray characters from elsewhere. Reverting to
// that flexGrow-only shape and re-running this file's own test suite reproduces it directly (a
// panel opened once the transcript already has content); this is the same failure family as the
// `flexBasis`/`overflow="hidden"` fix below, not a narrower one, so treat it as a real rendering
// hazard rather than an artifact of any one renderer. Wrapping it in a
// plain `<box flexGrow={1}>` and measuring THAT box's own settled height via `onSizeChange` (the
// exact pattern this component used before the scrollbox migration) sidesteps whatever in
// `ScrollBoxRenderable`'s own flex-based sizing this trips, by handing it a plain number instead.
// That wrapping box also needs `flexBasis={0}` and `overflow="hidden"` (below): without
// `flexBasis={0}`, Yoga derives the box's own flex-basis from its children's own height — the SAME
// number this component just fed the scrollbox last render — so opening a panel that needs more
// room than the transcript's previous share never shrinks the box below that stale number, and the
// scrollbox (still at its old, larger explicit height) paints over the panel's own rows instead.
// `flexBasis={0}` makes the box's share of the column purely "whatever `flexGrow`/`flexShrink`
// leave over after every sibling lays out," independent of its children's own declared height, so it
// shrinks to the panel's actual leftover space in the same layout pass the panel mounts in — no
// waiting on a second `onSizeChange` round-trip. `overflow="hidden"` is the backstop for the one
// case that still needs it: the scrollbox's own `height` prop is a number from THIS component's
// state, necessarily one render behind a same-frame layout change, so for that one frame it can
// still be taller than the box now measures — clipped here instead of bleeding into the rows below.
//
// Renderer lifecycle (mount, unmount, alt-screen entry/exit) is NOT this component's concern —
// unlike Ink, where `App` itself called `useApp().exit()` on a `done` prop, OpenTUI has no such
// hook: the three callers above own the `CliRenderer` directly and destroy it themselves once a
// quit is ready to complete (`getTuiRenderer`/`destroyTuiRenderer`, runtime/renderer.ts).
import { type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { findCatalogEntry, type ModelCatalog, type ModelProvider } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { useEffect, useReducer, useRef, useState } from "react";
import { isShiftTabModeCycle } from "../cli/commandCatalog";
import { truncateArgsDisplay } from "../cli/output";
import type { PermissionMode } from "../gate/gate";
import type { ApprovalAnswer } from "../loop/loop";
import { appliedReasoningEffort, resolveReasoningEffort } from "../provider/reasoning";
import type { ResolvedRoute } from "../provider/routing";
import type { SessionState } from "../session/session";
import { ApprovalBox } from "./components/ApprovalBox";
import { ChildTranscript } from "./components/ChildTranscript";
import { InputBox } from "./components/InputBox";
import { ModelPicker } from "./components/ModelPicker";
import { SubagentPanel } from "./components/SubagentPanel";
import { TranscriptList } from "./components/TranscriptList";
import { TurnStatus } from "./components/TurnStatus";
import { AuthBanner, AuthPanel } from "./routes/config/AuthPanel";
import { ConfigPanel } from "./routes/config/ConfigPanel";
import { EffortPanel } from "./routes/config/EffortPanel";
import { PermissionsPanel } from "./routes/config/PermissionsPanel";
import { SetupPanel } from "./routes/setup/SetupPanel";
import { WelcomeSplashPanel } from "./routes/setup/WelcomeSplashPanel";
import { type Dispatch, initialTuiState, tuiReducer } from "./state/reducer";
import { renderLiveToolActivity, summarizeArgs } from "./state/toolActivity";
import { theme } from "./theme/theme";
import { ErrorLine } from "./ui/ErrorLine";
import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  FALLBACK_CHROME_ROWS,
  formatModeDetail,
  MODE_CYCLE_HINT,
  MODE_HINT_COLS,
  MODE_LABEL,
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
  // formatModeDetail drops the model+route suffix entirely when `state.route` is undefined, rather
  // than showing a fabricated route ("your key" during a flow where there is provably no key yet
  // would be actively wrong, not just a placeholder).
  route: ResolvedRoute | undefined;
  // Used, alongside `state.route`, to look up the active model's `reasoningOptions` for the
  // persistent mode-indicator's `/effort` tier suffix (see the `catalogEntry`/`effortTier`
  // computation below). Same required-key/optional-VALUE shape as `route` above, for the same
  // reason: the key is required so a future `createElement(App, ...)` call site must explicitly
  // decide what to pass rather than silently omitting it; the value is `| undefined` because two
  // call sites (runGuidedSetup, runWelcomeSplash) mount App before any `PreparedRun`/catalog
  // exists at all.
  catalog: ModelCatalog | undefined;
  // Seeds `state.config` at mount — see `"config-updated"`'s own comment (reducer.ts) for what
  // that is and how it stays live afterward. Unlike `route`/`catalog` just above, this is never
  // `| undefined`: config.json can be read at any point in startup regardless of whether a
  // `PreparedRun` exists yet, so every call site (including the two that pass `route`/`catalog`
  // as `undefined`) has a real record to pass — `loadConfig` itself never fails to produce one,
  // returning `{}` rather than throwing when config.json doesn't exist.
  config: Record<string, string>;
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
  // /effort's own two resolutions, mirroring onModelSelected/
  // onModelPickerCancel's own shape exactly — one pair, since EffortPanel has only one step.
  // `leftoverInput`: threaded through to createEffortHandlers'
  // dispatched `effort-resolved` action, matching every other panel's own resolution shape —
  // see EffortPanel's own comment on why it is always `undefined` today.
  onEffortSelected?: (tier: string, leftoverInput?: string) => void;
  onEffortCancel?: (leftoverInput?: string) => void;
  // The welcome-splash mount's own three resolutions — unreachable in runTui/runGuidedSetup, whose
  // own initialTuiState calls never set pendingSplash (reducer.ts's own comment).
  onSplashLogin?: () => void;
  onSplashSignup?: () => void;
  onSplashContinue?: () => void;
  // Shift+Tab's own resolution — a prop, not a local dispatch into this component's own reducer:
  // `getPermissionMode()` (cli.ts) reads `liveState.session.permissionMode`, and `liveState` is
  // only ever advanced by cli.ts's own dispatch funnel. A cycle dispatched from inside this
  // component would never reach `liveState`, so the permission gate would keep enforcing the OLD
  // mode while this component's own state (and the indicator it renders) already showed the new
  // one — the exact desync `onSessionChange`'s own comment above already describes for persistence.
  onCycleMode?: () => void;
  // `--dangerously-skip-permissions` (already a `runTui` parameter, cli.ts) overrides
  // `getPermissionMode()` (cli.ts) to `"auto"` regardless of what `session.permissionMode` says —
  // this is the single render-time mirror of that override: the indicator must not claim a mode
  // the gate isn't actually enforcing. `state.session.permissionMode` stays the normal, untouched
  // source everywhere else (the reducer itself is not changed for this flag).
  // Also makes Shift+Tab inert while set, checked inside this component rather than left to every
  // caller to remember: a functioning binding would silently mutate and persist a session field
  // the gate is ignoring, with zero visible feedback.
  skipPermissions?: boolean;
};

// A pty can genuinely report a terminal width as a real but unusable `0` for the first render or
// two, before its window-size ioctl has actually landed (reproduced live over a real pty in WSL) —
// `formatModeDetail` (below) picks its display tier off this width, and a stray `0` would collapse
// it to the narrowest tier for no real reason. `|| DEFAULT_COLUMNS`, not `??`: `||` treats `0` the
// same as `undefined`/`null`, which is exactly the substitution a column count of zero needs —
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

// Below this width, the transcript scrollbox's own cosmetic left/right margin (below) is dropped
// rather than applied — empirically confirmed (narrowing the test renderer column by column) that
// stacking it with the assistant row's bullet gutter (BULLET_GUTTER, TranscriptList.tsx) leaves
// too little content width for `<markdown>` to render at all between widths 4-5, vs. rendering
// fine at those same widths with the margin dropped. 20 is a wide margin above that measured
// breakpoint, not a tuned value — any real terminal this narrow is already unusable for other
// reasons, so precision here isn't worth chasing further.
const TRANSCRIPT_PADDING_MIN_WIDTH = 20;

export function App({
  session,
  route,
  catalog,
  config,
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
  onEffortSelected,
  onEffortCancel,
  onSplashLogin,
  onSplashSignup,
  onSplashContinue,
  onCycleMode,
  skipPermissions,
}: AppProps) {
  const [state, dispatch] = useReducer(tuiReducer, initialTuiState(session, { route, config }));
  const { width: rawWidth, height: rawRows } = useTerminalDimensions();
  const width = resolveWidth(rawWidth);
  const rows = resolveHeight(rawRows);
  // The single render-time override `skipPermissions` needs — see `AppProps.skipPermissions`'s own
  // comment. One derived value, not two: `indicatorText` reads off `displayMode` rather than
  // carrying its own separate `skipPermissions` ternary, so the hue and the label can't disagree
  // about which mode is showing.
  const displayMode: PermissionMode =
    skipPermissions === true ? "auto" : state.session.permissionMode;
  const indicatorText = MODE_LABEL[displayMode];

  const transcriptRef = useRef<ScrollBoxRenderable>(null);
  // The scrollbox's own measured height (this file's own header comment explains why it needs a
  // definite number, not `flexGrow`) — `null` only for the frames before OpenTUI's own layout pass
  // has fired `onSizeChange` at least once on the wrapping box below; `FALLBACK_CHROME_ROWS` is a
  // placeholder for those frames alone, not a real chrome-height estimate. `Math.max(1, ...)`: the
  // wrapping box has `minHeight={0}`, so on a short enough terminal — or one where the sibling rows
  // above/below it already consume the whole budget — Yoga can genuinely measure it down to 0,
  // which a `<scrollbox height={0}>` would render as nothing rather than "not enough room."
  const [measuredRows, setMeasuredRows] = useState<number | null>(null);
  const transcriptHeight = Math.max(1, measuredRows ?? rows - FALLBACK_CHROME_ROWS);
  // TurnStatus (below) renders as its own fixed row OUTSIDE the scrollbox, not as one of its
  // scrollable children, so it stays visible regardless of scroll position (this file's own header
  // comment explains why) — the scrollbox itself only gets the wrapping box's remaining height once
  // that one row is set aside for it. Floored at 0, not 1: `transcriptHeight` can itself already be
  // the 1-row floor above, and flooring THIS at 1 too would claim that one row for the scrollbox and
  // leave TurnStatus none — the row this whole arrangement exists to protect. A `<scrollbox
  // height={0}>` renders as nothing (same as `transcriptHeight`'s own comment notes), which is the
  // correct trade on a terminal this short: TurnStatus visible, transcript not.
  // Named once and reused below (both for this reservation and for TurnStatus's own render gate)
  // rather than re-reading `state.turn !== undefined` at each call site — a future change to one
  // (e.g. adding a `noPanelOpen` check) that missed the other would silently desync the reservation
  // from what actually renders.
  const { turn } = state;
  const scrollboxHeight = Math.max(0, transcriptHeight - (turn !== undefined ? 1 : 0));

  // Drives the "↑ scrolled — End to follow" banner. Scroll position itself lives on the scrollbox
  // renderable, not on `state` (App.tsx's own header comment) — this mirrors it into React state by
  // reading the scrollbox's own current `scrollTop`/`scrollHeight`/`viewport.height` (the same
  // computation `updateStickyState`, @opentui/core's own source, uses internally), from two events:
  // `verticalScrollBar`'s own "change" event (`ScrollBarRenderable` extends `EventEmitter`, emitted
  // on every actual scroll-POSITION change) covers a mouse-wheel scroll — `ScrollBoxRenderable.
  // onMouseEvent` moves `scrollTop` through the exact same setter PageUp/PageDown/Home/End go
  // through below, so one listener covers both input paths — and the renderer root's own
  // "layout-changed" event (emitted after every Yoga layout pass, @opentui/core's own
  // `RootRenderable.calculateLayout`) covers a resize that changes how much of the content now fits
  // with the scroll POSITION unchanged (e.g. already at the top): growing the viewport enough to fit
  // everything re-engages `stickyStart` internally without moving `scrollTop` at all if it was
  // already 0, so there is no scroll-position CHANGE for the scrollbar's own event to fire on, even
  // though `scrolledUp` must still flip to `false` once the viewport genuinely grows past the
  // content. New content arriving never needs to update this on its own: `stickyScroll` already
  // either follows it (this was already `false`) or holds position (this was already `true`)
  // natively. `/clear` (`transcript-cleared`) needs no special case either, for the same reason as
  // a resize: shrinking the content is itself a Yoga layout change, so `layout-changed` fires and
  // `sync` recomputes `maxScrollTop` down to 0 (or below the now-shorter `scrollTop`) on its own —
  // confirmed empirically, not just by this reasoning (an earlier draft special-cased
  // `state.transcript.length === 0` directly; removing it and re-running the `/clear`-while-
  // scrolled-up regression below showed the plain `layout-changed` listener already covers it).
  const [scrolledUp, setScrolledUp] = useState(false);
  const renderer = useRenderer();
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    // `layout-changed` fires from `calculateLayout`, before the scrollbox's own `scrollHeight`/
    // `viewport.height` refresh (that happens later in the same layout pass) — so a single `sync`
    // call here can read one-frame-stale geometry; it settles on the NEXT `layout-changed` once Yoga
    // has caught up, which is why a shrink like `/clear` needs two passes to resolve, not one.
    const sync = () => {
      const maxScrollTop = Math.max(0, el.scrollHeight - el.viewport.height);
      setScrolledUp(el.scrollTop < maxScrollTop);
    };
    el.verticalScrollBar.on("change", sync);
    renderer.root.on("layout-changed", sync);
    return () => {
      el.verticalScrollBar.off("change", sync);
      renderer.root.off("layout-changed", sync);
    };
  }, [renderer]);

  useEffect(() => {
    connectDispatch?.(dispatch);
  }, [connectDispatch]);

  useEffect(() => {
    onSessionChange?.(state.session);
  }, [state.session, onSessionChange]);

  // True when no modal panel owns the keyboard. Child inspect is not a modal: InputBox stays
  // mounted and the shared scrollbox still takes PageUp/PageDown. The transcript box above
  // (flexGrow/minHeight={0}) still renders unconditionally regardless of which branch is active,
  // so on a terminal taller than the open panel's own content it stays partially visible above
  // it, not fully occluded — but PageUp/PageDown/Home/End must still not scroll it in the
  // background while a modal is open: the user would close the panel to find the transcript
  // scrolled and the "↑ scrolled" banner showing, with no visible keypress of theirs against
  // the transcript to explain why.
  const noPanelOpen =
    state.pendingApproval === undefined &&
    state.pendingModelPicker === undefined &&
    state.pendingSetup === undefined &&
    state.pendingAuth === undefined &&
    state.pendingConfig === undefined &&
    state.pendingPermissions === undefined &&
    state.pendingEffort === undefined &&
    !state.pendingSplash;

  // The mode row shares its line with the scroll banner / `state.status` (`justifyContent
  // "space-between"`, below) — the row's own tier thresholds are sized against the LEFT side
  // alone, so once the right side is actually showing, its own width has to come out of the
  // budget BOTH the hint's own visibility check and `formatModeDetail` see, or the two collide and
  // OpenTUI wraps the row across two lines. `+ 1` for the row's own `gap={1}` between banner and
  // status, only when both are shown at once. Also what the JSX below renders, rather than
  // re-typing the banner string a second time — the two can't drift apart if there's only one copy.
  const rightSideText = scrolledUp && noPanelOpen ? "↑ scrolled — End to follow" : "";
  const rawRightSideWidth =
    rightSideText.length +
    (rightSideText.length > 0 && state.status.length > 0 ? 1 : 0) +
    state.status.length;
  // `indicatorText` — the mode label — has no width tier of its own: unlike the hint/model/route,
  // it's never hidden or shortened as the terminal narrows (there's nothing smaller to fall back
  // to than the mode's own name). So on a narrow enough terminal, indicatorText + the right side
  // together can still exceed `width` even after the hint/detail have already given up all the
  // room they can. Rather than let that wrap the row, the right side loses instead: it only shows
  // when there's room for it alongside the label, which — like the hint/detail split above — is
  // real terminal width, not a real cell-width measurement (`.length`, not `stringWidth`; the
  // banner's own `—`/`↑` and `state.status`'s `…` can in principle render wider than 1 cell on a
  // terminal configured for ambiguous-width-double, same caveat the D3 glyphs already carry).
  const showRightSide = width >= indicatorText.length + rawRightSideWidth;
  const rightSideWidth = showRightSide ? rawRightSideWidth : 0;
  const catalogEntry =
    state.route !== undefined && catalog !== undefined
      ? findCatalogEntry(catalog, state.route.model, state.route.provider)
      : undefined;
  const effortTier = appliedReasoningEffort(
    resolveReasoningEffort(state.session, state.config),
    catalogEntry,
  );
  const modeDetail = formatModeDetail(state.route, width - rightSideWidth, effortTier);

  // Its own useKeyboard, separate from the scroll handler below — OpenTUI delivers the same
  // keypress to every registered handler (that handler's own comment explains this), so a second,
  // independent registration is the idiomatic way to keep two unrelated concerns from having to
  // reason about each other's ordering/guards, the same shape InputBox's own handler already uses.
  // Inert under skipPermissions (AppProps.skipPermissions's own comment): the indicator is pinned
  // to bypass regardless of what a cycle would compute, so a functioning binding here would
  // silently mutate and persist a session field the gate is already ignoring.
  useKeyboard((key) => {
    if (!noPanelOpen) return;
    if (isShiftTabModeCycle(key) && skipPermissions !== true) onCycleMode?.();
  });

  // A second, independent useKeyboard from InputBox's own — OpenTUI delivers the same keypress to
  // every registered handler, so this fires regardless of what InputBox does with the same press
  // (today, nothing: InputBox's own handler skips any key.ctrl input). Ctrl-C itself is NOT handled
  // here — `runtime/renderer.ts`'s own registration owns that, see its comment for why. Drives the
  // scrollbox ref directly (`scrollBy`/`unit`, @opentui/core's own `ScrollBoxRenderable`) rather than
  // dispatching into the reducer: scroll position is the scrollbox's own state now, not derived
  // state this component recomputes. The scrollbox itself is never given keyboard focus (no
  // `focused` prop, below), so its own internal `handleKeyPress` (which would otherwise also react
  // to these same keys) never fires — this is the ONLY place PageUp/PageDown/Home/End are handled.
  // Home/End's `scrollBy(∓1, "content")` matches `ScrollBarRenderable`'s own internal Home/End
  // handling one-for-one (verified against @opentui/core's own compiled source). PageUp/PageDown's
  // `scrollBy(∓1, "viewport")` deliberately does NOT match that same internal handling, which pages
  // by half a viewport per press (`scrollBy(∓0.5, "viewport")`) — a full-viewport jump is the
  // simpler of the two `scrollBy` unit multiples already available on this same API, chosen over
  // reproducing the pre-migration reducer's own one-row-overlap pager convention
  // (`viewportRows - reserved - 1`), which no longer has a `viewportRows`/`reserved` pair to compute
  // it from now that scroll position lives on the scrollbox itself.
  useKeyboard((key) => {
    if (!noPanelOpen) return;
    const el = transcriptRef.current;
    if (!el) return;
    if (key.name === "pageup") el.scrollBy(-1, "viewport");
    else if (key.name === "pagedown") el.scrollBy(1, "viewport");
    else if (key.name === "home") el.scrollBy(-1, "content");
    else if (key.name === "end") el.scrollBy(1, "content");
  });

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
      {/* flexGrow/flexShrink/flexBasis={0}/minHeight={0} give this box whatever height is left over
      after every sibling below has laid out, independent of its own children's height (this file's
      own header comment explains why `flexBasis={0}` and `overflow="hidden"` are both needed here) —
      `transcriptHeight` (above) reads that back via `onSizeChange`; `scrollboxHeight` (above) hands
      the scrollbox its own share as a definite number, one row short of `transcriptHeight` whenever
      TurnStatus (below) needs that row for itself. Fed the FULL `state.transcript` — no windowed
      slice — with `stickyScroll`/`stickyStart="bottom"` doing what the old reducer-computed offset
      used to: follow newly appended content while at the bottom, hold position when scrolled away
      from it. No mid-generation text is ever rendered here: `state.streaming` still accumulates
      every `text-delta` for `pushLine`'s next flush (state/reducer.ts), but each finished segment of
      the answer only appears once `pushLine` commits it as a normal transcript entry. The scrollbox
      itself is not given keyboard focus (no `focused` prop) — see the `useKeyboard` handler's own
      comment above for why. */}
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        overflow="hidden"
        onSizeChange={function onSizeChange(this: BoxRenderable) {
          setMeasuredRows(this.height);
        }}
      >
        {/* paddingLeft/paddingRight={1}: a one-column margin from both terminal edges for the
        transcript's own content — before this, content ran flush to the right edge while the
        left edge only looked padded because of the assistant row's own bullet-prefix indent, not
        a real margin on every row. Scoped to the scrollbox (not the app root) so it doesn't also
        shift the mode indicator/input box/panels below it, which aren't model output. On the
        scrollbox directly, not an inner wrapper box: an inner box here was tried and works too,
        but padding the scrollbox itself is one prop instead of an extra element.
        Dropped below TRANSCRIPT_PADDING_MIN_WIDTH: stacked with the assistant row's own bullet
        gutter (BULLET_GUTTER, TranscriptList.tsx), this padding left as little as 0 columns of actual content
        width at a narrow terminal — confirmed empirically to stop assistant markdown from
        rendering at all (not just narrowing it) at widths 4-5, where the bullet gutter alone
        still rendered fine. The margin is cosmetic; making it recede at extreme widths trades a
        breathing-room nicety for the transcript still rendering at all. */}
        <scrollbox
          ref={transcriptRef}
          height={scrollboxHeight}
          stickyScroll
          stickyStart="bottom"
          paddingLeft={width >= TRANSCRIPT_PADDING_MIN_WIDTH ? 1 : 0}
          paddingRight={width >= TRANSCRIPT_PADDING_MIN_WIDTH ? 1 : 0}
        >
          {state.pendingChildView === undefined ? (
            <>
              <TranscriptList transcript={state.transcript} />
              {/* Settled toolActivity groups, painted live inside the scrollbox so mid-turn
              scrollback includes them. pendingTool (below) stays pinned outside. After
              flushToolActivity, toolActivity is [] and this region unmounts in the same
              update that pushLine's the muted transcript entries — no double paint. */}
              {renderLiveToolActivity(state.toolActivity).map((line, index) => (
                <text key={index} fg={theme.muted}>
                  {line}
                </text>
              ))}
            </>
          ) : (
            <ChildTranscript
              child={state.subagents.find((row) => row.id === state.pendingChildView)}
            />
          )}
        </scrollbox>
        {/* Rendered as a fixed row OUTSIDE the scrollbox, directly under it, instead of as one of
        its scrollable children — a scrollbox child scrolls out of view exactly like any other row
        once the reader scrolls away from the tail, which TurnStatus must not do while a turn is
        active (`scrollboxHeight`, above, already sets the scrollbox one row short to leave this
        exactly the room it needs). Keyed on `state.turn.startedAt`, defensively: `runTurn` (cli.ts)
        has a single `turn-started` dispatch site, reached from two call paths — an interactive
        submission and a mount-time task/resume start — both input-driven, always separated from the
        prior turn's `turn-ended` by a user keystroke, so React never has the chance to batch two
        `turn-started` dispatches into one commit. But IF it ever did — a `turn-ended` and the next
        `turn-started` landing in the same update — the intermediate "no turn in flight" render
        (where TurnStatus would otherwise unmount) would never actually commit, and TurnStatus would
        be REUSED rather than remounted, so its `useState(() => Date.now())` initializer
        (TurnStatus's own comment) would not re-run and the second turn would start ticking from the
        first turn's stale `now`. The key forces a fresh element identity — and so a fresh mount —
        regardless. */}
        {turn !== undefined && (
          <TurnStatus key={turn.startedAt} startedAt={turn.startedAt} tokenProgress={turn.tokens} />
        )}
      </box>
      {state.pendingTool !== undefined &&
        !(state.pendingTool.name === "dispatch_subagents" && state.subagents.length > 0) &&
        (state.pendingTool.name === "write_file" || state.pendingTool.name === "edit" ? (
          <box borderStyle="single" borderColor={theme.warning}>
            {/* truncateArgsDisplay (cli/output.ts), not a raw JSON.stringify: write_file/edit
            args carry a whole file body — exactly the case the helper exists for, uncapped
            here otherwise. */}
            <text fg={theme.warning}>
              {`${state.pendingTool.name}(${truncateArgsDisplay(state.pendingTool.args)})`}
            </text>
          </box>
        ) : (
          <text fg={theme.muted}>
            {summarizeArgs(state.pendingTool.name, state.pendingTool.args)}
          </text>
        ))}
      <ErrorLine message={state.commandError} />
      {/* Mutually exclusive with InputBox — a pending approval question is the only thing this run
      is waiting on, and answering it (not typing a task or slash command) is the only input that
      means anything until it clears. Extended to a third state for /model, a fourth for /setup,
      four more for /login /signup, /config, /permissions and /effort: each is the same kind of
      "only this input means anything right now" question, checked in this same order (approval,
      /model, /setup, /login /signup, /config, /permissions, /effort, then InputBox). Child
      inspect keeps InputBox mounted and inert. Every branch here — including
      AuthPanel/ConfigPanel/PermissionsPanel/EffortPanel — is a real, wired OpenTUI
      component; state/handlers.ts and cli.ts dispatch auth-requested/config-requested/
      permissions-requested/effort-requested. */}
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
      ) : state.pendingEffort !== undefined ? (
        <EffortPanel
          pendingEffort={state.pendingEffort}
          onEffortSelected={onEffortSelected}
          onEffortCancel={onEffortCancel}
        />
      ) : state.pendingSplash ? (
        <WelcomeSplashPanel
          authenticated={!state.authOffer}
          onLogin={onSplashLogin}
          onSignup={onSplashSignup}
          onContinue={onSplashContinue}
        />
      ) : onSubmit === undefined ? (
        // Nothing is wired behind this mount yet. The welcome splash and the guided setup
        // (routes/setup/) render this same component before a session exists, and both keep it on
        // screen for as long as the startup work behind them takes — the models.dev fetch on the
        // way to `prepareSession` alone can hold it for seconds. Rendering InputBox here is what
        // used to swallow a task typed in that window (issue #211): it echoed the text and dropped
        // it on Enter, with nowhere to send it. Same top/bottom rule as InputBox so the mode row
        // below does not jump when the real session mounts.
        <box
          flexDirection="row"
          borderStyle="single"
          borderColor={theme.muted}
          border={["top", "bottom"]}
        >
          <text fg={theme.muted}>starting session…</text>
        </box>
      ) : (
        <InputBox
          onSubmit={onSubmit}
          onQuit={onQuit}
          prefill={state.pendingInputPrefill}
          onPrefillConsumed={() => dispatch({ type: "input-prefill-consumed" })}
          onEmptyDown={
            state.subagents.length > 0
              ? () => dispatch({ type: "subagent-panel-focus" })
              : undefined
          }
          inert={state.subagentPanelFocus || state.pendingChildView !== undefined}
        />
      )}
      {state.subagents.length > 0 && (
        <SubagentPanel
          subagents={state.subagents}
          focused={state.subagentPanelFocus}
          selectedId={state.subagentPanelSelectedId}
          dispatch={dispatch}
        />
      )}
      <box flexDirection="row" justifyContent="space-between">
        {/* No `gap` — all spacing between these three is carried inside the strings themselves
        (MODE_CYCLE_HINT's own leading space, `modeDetail`'s own leading two spaces), so the mode
        hue never bleeds onto the hint/model/route by way of an inserted gap cell. */}
        <box flexDirection="row">
          <text fg={theme.mode[displayMode]}>{indicatorText}</text>
          {width - rightSideWidth >= MODE_HINT_COLS && (
            <text fg={theme.muted}>{MODE_CYCLE_HINT}</text>
          )}
          <text fg={theme.muted}>{modeDetail}</text>
        </box>
        <box flexDirection="row" gap={1}>
          {/* `rightSideText`, not a re-check of `scrolledUp && noPanelOpen` (`noPanelOpen` matters
          here too: while a panel is open, End is swallowed by the exact same gate that puts on the
          transcript-scroll keys above — the banner would otherwise keep telling the user to press
          a key that does nothing until they close the panel first) — reusing the already-computed
          string keeps this render in lockstep with the width budget above, rather than risking the
          two drifting if one is ever edited without the other. `showRightSide` on both nodes: the
          label can't shrink, so on a narrow enough terminal these lose the row instead of wrapping
          it (see `showRightSide`'s own comment above). */}
          {showRightSide && rightSideText.length > 0 && (
            <text fg={theme.muted}>{rightSideText}</text>
          )}
          {showRightSide && state.status.length > 0 && <text fg={theme.muted}>{state.status}</text>}
        </box>
      </box>
    </box>
  );
}
