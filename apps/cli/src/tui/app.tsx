/** @jsxImportSource @opentui/react */
// Root TUI component, rendered inside the one `CliRenderer` shared by `routes/setup/
// welcomeSplash.ts`, `routes/setup/guidedSetup.ts`, and `cli.ts`'s `runTui` (`runtime/renderer.ts`,
// `screenMode: "alternate-screen"`) — each phase `root.render`s different props into the same
// instance rather than mounting its own. The transcript is a native `<scrollbox>` whose
// `stickyScroll`/`stickyStart="bottom"` (below) follow newly appended content while at the
// bottom, and hold position when scrolled away from it, natively (OpenTUI's own Yoga layout +
// scroll-anchor logic, not a reducer-computed slice). `state.transcript` stays the complete
// append-only array; `TranscriptList` mounts only the viewport plus overscan and holds the
// unmounted prefix/suffix as spacer boxes so `scrollHeight` still matches the full history. No
// mid-generation text is ever rendered in it: `text-delta` chunks buffer off the React path until
// a non-delta action drains them into `tuiReducer` as one `state.streaming` append for `pushLine`'s
// next flush (state/reducer.ts, state/streamDispatch.ts), and that buffer is never itself displayed
// live — while a turn is active, `TurnStatus` (below) stays mounted for the whole turn as a fixed row OUTSIDE
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
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { findCatalogEntry, type ModelCatalog, type ModelProvider } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { isShiftTabModeCycle } from "../cli/commandCatalog";
import type { PermissionMode } from "../gate/gate";
import type { ApprovalAnswer } from "../loop/loop";
import type { McpLoginResult } from "../mcp/login";
import type { McpCatalog } from "../mcp/types";
import { appliedReasoningEffort, resolveReasoningEffort } from "../provider/reasoning";
import type { ResolvedRoute } from "../provider/routing";
import type { SessionState } from "../session/session";
import { ApprovalBox } from "./components/ApprovalBox";
import { ChildTranscript } from "./components/ChildTranscript";
import { InputBox } from "./components/InputBox";
import { ModelPicker } from "./components/ModelPicker";
import { QueueBlock } from "./components/QueueBlock";
import { SubagentPanel } from "./components/SubagentPanel";
import { indentReasoningBody, TranscriptList } from "./components/TranscriptList";
import { TurnStatus } from "./components/TurnStatus";
import { AuthPanel } from "./routes/config/AuthPanel";
import { ConfigPanel } from "./routes/config/ConfigPanel";
import { EffortPanel } from "./routes/config/EffortPanel";
import { PermissionsPanel } from "./routes/config/PermissionsPanel";
import { McpPanel } from "./routes/mcp/McpPanel";
import { MemoryPanel } from "./routes/memory/MemoryPanel";
import { SetupPanel } from "./routes/setup/SetupPanel";
import { SplashBanner, type SplashBannerInfo } from "./routes/setup/SplashBanner";
import { WelcomeSplashPanel } from "./routes/setup/WelcomeSplashPanel";
import { SkillsPanel } from "./routes/skills/SkillsPanel";
import type { SetupProviderRow } from "./state/commands";
import { type Dispatch, initialTuiState } from "./state/reducer";
import { createStreamDispatch } from "./state/streamDispatch";
import { renderLiveToolActivity, summarizeArgs } from "./state/toolActivity";
import { FRAME, gapBefore } from "./theme/spacing";
import { approvalCopy } from "./util/approvalCopy";
import { theme } from "./theme/theme";
import { ErrorLine } from "./ui/ErrorLine";
import type { CompletionSource } from "./util/completion";
import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  FALLBACK_CHROME_ROWS,
  formatModeDetail,
  MODE_CYCLE_HINT,
  MODE_LABEL,
  modeRowHintVisible,
} from "./util/format";
import { quantizeScrollTop } from "./util/visibleTranscriptWindow";

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
  // The seam driveLoop's dispatch is wired through: called once on mount with App's own
  // dispatch (stream-coalesced for text-delta). Optional because some tests exercise
  // the tree via `connectDispatch` directly, with no live loop behind it.
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
  // Escape at the input box while a turn is in flight: cancels it, after which cli.ts's own
  // drainQueue starts whatever was queued behind it. A prop rather than a `deliverSignal` call from
  // this component, on the same split every other interactive surface here follows — presentation
  // calls a prop, cli.ts owns the decision — and here that split is load-bearing rather than
  // stylistic: the guards that keep an Escape away from signals.ts's fatal path read `turnInFlight`
  // and a per-turn latch, neither of which exists on this side of the boundary. See `onEscape` in
  // cli.ts for what each guard prevents.
  onEscape?: () => void;
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
  onSetupSelect?: (row: SetupProviderRow) => void;
  onSetupKeyEntered?: (provider: ModelProvider, value: string) => void;
  onSetupRemove?: (row: SetupProviderRow) => void;
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
  // /skills' own single resolution. Closing is dispatched locally, like every other panel's Esc;
  // running needs cli.ts's own turn machinery, so it is a prop.
  onSkillRun?: (name: string) => void;
  // /mcp's own three resolutions. Closing is dispatched locally, like every other panel's Esc;
  // dialling and writing the trusted catalog are both network/disk I/O cli.ts owns, so they are
  // props — the same "presentation calls a prop, cli.ts owns the decision" split every other
  // interactive command on this type already has.
  onMcpConnect?: (
    name: string,
  ) => Promise<{ ok: true; catalog: McpCatalog } | { ok: false; message: string }>;
  onMcpTrust?: (catalog: McpCatalog) => void;
  onMcpRemove?: (name: string) => void;
  onMcpAuth?: (name: string) => Promise<McpLoginResult>;
  onMcpAuthCancel?: () => void;
  // /memory's own three resolutions. Closing is dispatched locally, like every other panel's Esc;
  // reading a staged write's diff and applying or discarding it are all disk I/O cli.ts owns, so
  // they are props — the same split /mcp's own trio above already has.
  onMemoryDiff?: (id: string) => string[];
  onMemoryApprove?: (id: string) => void;
  onMemoryReject?: (id: string) => void;
  // Every completion source the input box may open (util/completion.ts). A function, not an array:
  // runTui is the only place the command catalog, the agent registry and the skill registry are all
  // in scope, and `/clear` reloads the latter two mid-process — so this is called at render time
  // rather than captured, and a skill approved since startup completes after a /clear.
  getCompletionSources?: () => readonly CompletionSource[];
  // Seeds `pendingSplash` at `useState` init. `connectDispatch`'s `splash-requested` cannot win
  // the first paint: that effect runs after the first commit. `runWelcomeSplash` is the only
  // production caller that passes true; `runTui` / `runGuidedSetup` omit it.
  showSplash?: boolean;
  // Seeds `authOffer` the same way. Default false would paint the authenticated "Continue" menu
  // on a splash first frame until `auth-offer` landed from `connectDispatch`.
  authOffer?: boolean;
  // The welcome-splash mount's own three resolutions — unreachable in runTui/runGuidedSetup, whose
  // own initialTuiState calls never set pendingSplash (reducer.ts's own comment).
  onSplashLogin?: () => void;
  onSplashSignup?: () => void;
  onSplashContinue?: () => void;
  // The splash's own identity block (routes/setup/SplashBanner.tsx). Not derived from `route`/
  // `catalog` above, which are both genuinely `undefined` at the only mount that renders the
  // splash — `runWelcomeSplash` computes it from config.json and package.json instead, and passes
  // it through here rather than this component reaching for either itself.
  splashBanner?: SplashBannerInfo;
  // Takes the first task typed before a session exists. `runWelcomeSplash` passes this; the value
  // reaches `runTui` through `run()` (cli.ts), not through this component's own state, because the
  // renderer unmounts each phase's tree before rendering the next (runtime/renderer.ts) — nothing
  // in a reducer survives the hop from this mount to the session's.
  onPreSessionSubmit?: (task: string) => void;
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
// leftover packing of the mode-row detail (below) would otherwise see a 0 leftover and drop the
// suffix for no real reason. `|| DEFAULT_COLUMNS`, not `??`: `||` treats `0` the same as
// `undefined`/`null`, which is exactly the substitution a column count of zero needs — there is
// no real terminal width `0` is ever the correct value for.
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

function WritePreview({ name, args }: { name: string; args: unknown }) {
  const copy = approvalCopy(name, args);
  return (
    <box {...FRAME} flexDirection="column">
      <text fg={theme.text}>{copy.headline}</text>
      {copy.detail.length > 0 && <text fg={theme.muted}>{copy.detail}</text>}
    </box>
  );
}

export function App({
  session,
  route,
  catalog,
  config,
  connectDispatch,
  onSubmit,
  onSessionChange,
  onQuit,
  onEscape,
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
  onSkillRun,
  onMcpConnect,
  onMcpTrust,
  onMcpRemove,
  onMcpAuth,
  onMcpAuthCancel,
  onMemoryDiff,
  onMemoryApprove,
  onMemoryReject,
  getCompletionSources,
  onSplashLogin,
  onSplashSignup,
  onSplashContinue,
  splashBanner,
  onPreSessionSubmit,
  onCycleMode,
  skipPermissions,
  showSplash,
  authOffer,
}: AppProps) {
  const [state, setState] = useState(() =>
    initialTuiState(session, { route, config, showSplash, authOffer }),
  );
  const stream = useMemo(() => createStreamDispatch(setState), []);
  const dispatch = stream.dispatch;
  const [pendingReasoning, setPendingReasoning] = useState("");
  useEffect(() => stream.subscribe(() => setPendingReasoning(stream.getPendingReasoning())), [stream]);
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
  // InputBox sets this while its completion popup owns Up/Down, so a wheel-as-arrow notch over
  // a half-typed `/` cycles the list instead of also scrolling the transcript. Read on the
  // keypress, not copied into React state: the popup's open-ness is already InputBox-local, and
  // mirroring it here would add a render for no paint.
  const arrowsReservedRef = useRef(false);
  // The scrollbox's own measured height (this file's own header comment explains why it needs a
  // definite number, not `flexGrow`) — `null` only for the frames before OpenTUI's own layout pass
  // has fired `onSizeChange` at least once on the wrapping box below; `FALLBACK_CHROME_ROWS` is a
  // placeholder for those frames alone, not a real chrome-height estimate. `Math.max(1, ...)`: the
  // wrapping box has `minHeight={0}`, so on a short enough terminal — or one where the sibling rows
  // above/below it already consume the whole budget — Yoga can genuinely measure it down to 0,
  // which a `<scrollbox height={0}>` would render as nothing rather than "not enough room."
  const [measuredRows, setMeasuredRows] = useState<number | null>(null);
  // The one task accepted before a session exists (the `onPreSessionSubmit` branch below).
  // Local, not reducer state: it never outlives this mount — `run()` holds the value that
  // actually reaches the session, and this only decides whether the box is still offered.
  const [queued, setQueued] = useState<string | undefined>(undefined);
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
  const [scrollTop, setScrollTop] = useState(0);
  const renderer = useRenderer();
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    // `layout-changed` fires from `calculateLayout`, before the scrollbox's own `scrollHeight`/
    // `viewport.height` refresh (that happens later in the same layout pass) — so a single `sync`
    // call here can read one-frame-stale geometry; it settles on the NEXT `layout-changed` once Yoga
    // has caught up, which is why a shrink like `/clear` needs two passes to resolve, not one.
    //
    // That second pass used to arrive for free, from the scrollbar itself: crossing the
    // fits/overflows boundary flipped its own `visible`, which set `display: none` on its Yoga node
    // and so dirtied the layout again. Hiding it for good (below) takes that away, and the mirror
    // was left permanently one frame stale — a terminal grown until everything fits kept showing
    // "↑ scrolled". So the settled read is asked for directly instead of hoped for: `Renderable`
    // emits its own "resize" AFTER running the `onSizeChange` the scrollbox registers on these two
    // (@opentui/core's own `onResize`), and that callback is `recalculateBarProps` — the very
    // refresh `layout-changed` is too early for. Both children are needed: the viewport's own size
    // changes on a terminal resize, the content's on a `/clear`.
    const sync = () => {
      const maxScrollTop = Math.max(0, el.scrollHeight - el.viewport.height);
      setScrolledUp(el.scrollTop < maxScrollTop);
      // Quantized so TranscriptList does not rebuild its mount range on every
      // wheel tick; overscan covers the distance between quanta. Home is 0 and
      // stays 0 (`quantizeScrollTop`), which is what the not-sticky start-at-0
      // path needs.
      const nextTop = quantizeScrollTop(el.scrollTop);
      setScrollTop((prev) => (prev === nextTop ? prev : nextTop));
    };
    el.verticalScrollBar.on("change", sync);
    el.viewport.on("resize", sync);
    el.content.on("resize", sync);
    renderer.root.on("layout-changed", sync);
    return () => {
      el.verticalScrollBar.off("change", sync);
      el.viewport.off("resize", sync);
      el.content.off("resize", sync);
      renderer.root.off("layout-changed", sync);
    };
  }, [renderer]);

  useEffect(() => {
    connectDispatch?.(dispatch);
  }, [connectDispatch, dispatch]);

  useEffect(() => {
    onSessionChange?.(state.session);
  }, [state.session, onSessionChange]);

  // True when a modal panel that also claims the paging keys is the one ON SCREEN. Child inspect is
  // not a modal: InputBox stays mounted and the shared scrollbox still takes PageUp/PageDown. The
  // transcript box above (flexGrow/minHeight={0}) still renders unconditionally regardless of which
  // branch is active, so on a terminal taller than the open panel's own content it stays partially
  // visible above it, not fully occluded — but PageUp/PageDown/Home/End must still not scroll it in
  // the background while one of these is showing: the user would close the panel to find the
  // transcript scrolled and the "↑ scrolled" banner showing, with no visible keypress of theirs
  // against the transcript to explain why.
  //
  // An approval is the one overlay the keys stay live behind, because reading back what you are
  // approving is the entire point of the moment — the transcript above it is the diff, the command,
  // the path. It is also the one moment the user cannot recover from by learning a different key:
  // the wheel that used to scroll behind a panel now arrives as Up/Down (mouse reporting
  // is off; runtime/renderOptions.ts) and this same handler routes those to the transcript.
  // Nothing is silently mutated behind an approval either — the
  // ApprovalBox is the ONLY thing on screen the keys could confuse the reader about, it stays put
  // while the transcript moves under it, and the banner below is un-gated in the same breath so a
  // scrolled transcript always says so. The two must be gated on the same boolean, which is why
  // this is one list read twice rather than the same condition written out twice.
  //
  // Which is why `pendingApproval` guards the whole list instead of being a tenth field in it:
  // "on screen" and "in state" come apart here. Panel commands stay legal mid-turn (cli.ts's own
  // `tuiHandlers`), so a /model or /config left open when an approval arrives leaves both fields
  // set at once — and the render ternary below checks `pendingApproval` FIRST, so the ApprovalBox
  // is what the user is looking at. Reading the list on its own would leave the keys dead and the
  // banner suppressed behind a fully visible approval, in the one state that needs them most.
  // `pendingSplash` sits outside that override for the same reason from the other side: it returns
  // above the ternary, so it is the one panel an approval does not appear over.
  const pagingPanelOpen =
    state.pendingSplash ||
    (state.pendingApproval === undefined &&
      (state.pendingModelPicker !== undefined ||
        state.pendingSetup !== undefined ||
        state.pendingAuth !== undefined ||
        state.pendingConfig !== undefined ||
        state.pendingPermissions !== undefined ||
        state.pendingEffort !== undefined ||
        state.pendingSkills !== undefined ||
        state.pendingMcp !== undefined ||
        state.pendingMemory !== undefined));

  // True when NOTHING modal owns the keyboard, approvals included — what every binding that is not
  // transcript paging still gates on (shift+tab's mode cycle below).
  const noPanelOpen = !pagingPanelOpen && state.pendingApproval === undefined;

  // The mode row shares its line with the scroll banner / `state.status` (`justifyContent
  // "space-between"`, below) — leftover packing of the left-side detail and the hint-yield check
  // both see remaining width after the right side is reserved, or the two collide and OpenTUI
  // wraps the row across two lines. `+ 1` for the row's own `gap={1}` between banner and status,
  // only when both are shown at once. Also what the JSX below renders, rather than re-typing the
  // banner string a second time — the two can't drift apart if there's only one copy.
  const rightSideText = scrolledUp && !pagingPanelOpen ? "↑ scrolled — End to follow" : "";
  const rawRightSideWidth =
    rightSideText.length +
    (rightSideText.length > 0 && state.status.length > 0 ? 1 : 0) +
    state.status.length;
  // `indicatorText` — the mode label — has no width tier of its own: unlike the hint/model/route,
  // it's never hidden or shortened as the terminal narrows (there's nothing smaller to fall back
  // to than the mode's own name). So on a narrow enough terminal, indicatorText + the right side
  // together can still exceed `width` even after leftover packing has already given up all the
  // room it can. Rather than let that wrap the row, the right side loses instead: it only shows
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
  const remaining = width - rightSideWidth;
  const modeDetail = formatModeDetail(
    state.route,
    Math.max(0, remaining - indicatorText.length),
    effortTier,
  );
  const showModeHint = modeRowHintVisible(remaining, indicatorText.length, modeDetail.length);

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
    // Mouse reporting is off, so the live pin cannot be clicked. ctrl+t does
    // not steal ↑/↓ or shift+tab; InputBox already ignores key.ctrl.
    if (key.ctrl && key.name === "t") dispatch({ type: "reasoning-toggled" });
  });

  // A second, independent useKeyboard from InputBox's own — OpenTUI delivers the same keypress to
  // every registered handler, so this fires regardless of what InputBox does with the same press
  // (today, nothing: InputBox's own handler skips any key.ctrl input). Ctrl-C itself is NOT handled
  // here — `runtime/renderer.ts`'s own registration owns that, see its comment for why. Drives the
  // scrollbox ref directly (`scrollBy`/`unit`, @opentui/core's own `ScrollBoxRenderable`) rather than
  // dispatching into the reducer: scroll position is the scrollbox's own state now, not derived
  // state this component recomputes. The scrollbox itself is never given keyboard focus (no
  // `focused` prop, below), so its own internal `handleKeyPress` (which would otherwise also react
  // to these same keys) never fires — this is the ONLY place PageUp/PageDown/Home/End/Up/Down are
  // handled. Home/End's `scrollBy(∓1, "content")` matches `ScrollBarRenderable`'s own internal
  // Home/End handling one-for-one (verified against @opentui/core's own compiled source).
  // PageUp/PageDown's `scrollBy(∓1, "viewport")` deliberately does NOT match that same internal
  // handling, which pages by half a viewport per press (`scrollBy(∓0.5, "viewport")`) — a
  // full-viewport jump is the simpler of the two `scrollBy` unit multiples already available on
  // this same API, chosen over reproducing the pre-migration reducer's own one-row-overlap pager
  // convention (`viewportRows - reserved - 1`), which no longer has a `viewportRows`/`reserved`
  // pair to compute it from now that scroll position lives on the scrollbox itself.
  // Up/Down use `step` (one row) because that is what a wheel notch becomes once mouse reporting
  // is off: the terminal types one to three arrows per notch, and a viewport jump per arrow would
  // page the transcript three times for one physical flick. Ctrl/Meta is left alone so the queue
  // chords keep working; `arrowsReservedRef` is left alone so an open completion popup keeps
  // owning the list. Gated on `pagingPanelOpen` rather than `noPanelOpen` — an approval is
  // scrollable behind, see that boolean's own comment.
  useKeyboard((key) => {
    if (pagingPanelOpen) return;
    const el = transcriptRef.current;
    if (!el) return;
    if (key.name === "pageup") el.scrollBy(-1, "viewport");
    else if (key.name === "pagedown") el.scrollBy(1, "viewport");
    else if (key.name === "home") el.scrollBy(-1, "content");
    else if (key.name === "end") el.scrollBy(1, "content");
    else if (key.ctrl || key.meta || arrowsReservedRef.current) return;
    else if (key.name === "up") el.scrollBy(-1, "step");
    else if (key.name === "down") el.scrollBy(1, "step");
  });

  // The splash owns the whole terminal and returns before the session chrome below it renders.
  // It is the one phase with nothing behind it — no transcript, no session, no input box — so
  // rendering it in the panel slot at the bottom of that column left the entire viewport above it
  // blank. `flexGrow` on the panel itself (WelcomeSplashPanel.tsx) is what makes its border span
  // the full height instead of hugging its own content.
  if (state.pendingSplash) {
    return (
      <box flexDirection="column" height={rows}>
        <WelcomeSplashPanel
          authenticated={!state.authOffer}
          banner={splashBanner}
          onLogin={onSplashLogin}
          onSignup={onSplashSignup}
          onContinue={onSplashContinue}
        />
      </box>
    );
  }

  return (
    // No `height - 1` spare-row workaround: that existed only for Ink's own console-patching
    // full-redraw path (`resolveOutput`'s `isFullscreen` check racing `log-update`'s line-count
    // bookkeeping on a mid-run `console.*` write) — OpenTUI is a native terminal renderer with its
    // own buffer/diffing, not a diff-and-reprint-over-stdout library, so there is no equivalent
    // "console write scrolls the viewport out from under the redraw bookkeeping" failure mode to
    // guard against. Full terminal height is used directly.
    <box flexDirection="column" height={rows}>
      {/* flexGrow/flexShrink/flexBasis={0}/minHeight={0} give this box whatever height is left over
      after every sibling below has laid out, independent of its own children's height (this file's
      own header comment explains why `flexBasis={0}` and `overflow="hidden"` are both needed here) —
      `transcriptHeight` (above) reads that back via `onSizeChange`; `scrollboxHeight` (above) hands
      the scrollbox its own share as a definite number, one row short of `transcriptHeight` whenever
      TurnStatus (below) needs that row for itself. `state.transcript` is still the complete array
      — the mount window lives in `TranscriptList`, as spacers plus a slice, so this scrollbox's
      own `scrollHeight` stays the height of the full history. `stickyScroll`/`stickyStart="bottom"`
      still do what the old reducer-computed offset used to: follow newly appended content while at
      the bottom, hold position when scrolled away from it. No mid-generation text is ever rendered
      here: pending `text-delta` text drains into `state.streaming` on the next non-delta action for
      `pushLine`'s flush (state/reducer.ts), and each finished segment of the answer only appears
      once `pushLine` commits it as a normal transcript entry. The scrollbox
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
        breathing-room nicety for the transcript still rendering at all.
        verticalScrollbarOptions: with mouse reporting off (runtime/renderOptions.ts) the thumb
        cannot be dragged and the track cannot be clicked, and it is not merely dead — it paints
        real block glyphs (█ ▀ ▄) into the frame's last column, so a terminal-native drag across a
        full line copies one, and trailing-whitespace trimming does not strip a █. Nothing is lost
        by hiding it: the "↑ scrolled — End to follow" banner is already this app's own scroll
        position indicator, and it says what to press, which a thumb never did. `visible` (not the
        scrollbar's other props) is what actually removes it, and it sticks — `ScrollBarRenderable`'s
        own setter latches `_manualVisibility`, which its `recalculateVisibility` then early-returns
        on, so a later transcript append cannot show it again. */}
        <scrollbox
          ref={transcriptRef}
          height={scrollboxHeight}
          stickyScroll
          stickyStart="bottom"
          paddingLeft={width >= TRANSCRIPT_PADDING_MIN_WIDTH ? 1 : 0}
          paddingRight={width >= TRANSCRIPT_PADDING_MIN_WIDTH ? 1 : 0}
          verticalScrollbarOptions={{ visible: false }}
        >
          {state.pendingChildView === undefined ? (
            <>
              {/* The session header, inside the scrollbox rather than pinned above it, so it
              behaves the way Codex's own session history cell does: it holds the top of an empty
              transcript, and scrolls away on its own once enough conversation accumulates below
              it. Static after mount — a later `/model` switch moves `state.route` and the mode
              indicator, not this, which reports what the session opened on. */}
              {splashBanner !== undefined && <SplashBanner info={splashBanner} />}
              <TranscriptList
                transcript={state.transcript}
                scrollTop={scrollTop}
                viewportHeight={scrollboxHeight}
                sticky={!scrolledUp}
                columns={width}
              />
              {state.reasoning.expanded &&
                ((state.reasoning.live?.text ?? "") + pendingReasoning).length > 0 && (
                  <text
                    fg={theme.muted}
                    marginTop={gapBefore(state.transcript.at(-1)?.role, "system")}
                  >
                    {indentReasoningBody((state.reasoning.live?.text ?? "") + pendingReasoning)}
                  </text>
                )}
              {/* Settled toolActivity groups, painted live inside the scrollbox so mid-turn
              scrollback includes them. pendingTool (below) stays pinned outside. After
              flushToolActivity, toolActivity is [] and this region unmounts in the same
              update that pushLine's the muted transcript entries — no double paint.
              These rows sit outside TranscriptList, so its own per-row rhythm cannot reach them.
              The first row reads the last committed entry's role and takes its gap from the same
              table: usually the user message that opened the turn, but a retry or compaction
              notice can land in between, which a hardcoded pair would space wrongly. */}
              {renderLiveToolActivity(state.toolActivity).map((line, index) => (
                <text
                  key={index}
                  fg={theme.muted}
                  marginTop={index === 0 ? gapBefore(state.transcript.at(-1)?.role, "system") : 0}
                >
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
          <TurnStatus
            key={turn.startedAt}
            startedAt={turn.startedAt}
            tokenProgress={turn.tokens}
            pendingLiveOutputEstimate={stream.getPendingLiveOutputEstimate}
            subscribePendingLive={stream.subscribe}
            thinking={
              (state.reasoning.live?.text.length ?? 0) > 0 || pendingReasoning.length > 0
            }
            thinkingExpanded={state.reasoning.expanded}
            toolInFlight={state.pendingTool !== undefined}
          />
        )}
      </box>
      {state.pendingTool !== undefined &&
        !(state.pendingTool.name === "dispatch_subagents" && state.subagents.length > 0) &&
        (state.pendingTool.name === "write_file" || state.pendingTool.name === "edit" ? (
          <WritePreview name={state.pendingTool.name} args={state.pendingTool.args} />
        ) : (
          <text fg={theme.muted}>
            {summarizeArgs(state.pendingTool.name, state.pendingTool.args)}
          </text>
        ))}
      <ErrorLine message={state.commandError} />
      {/* Directly above the input box and below TurnStatus, which is where the issue's own
      simulation puts it: a queued message has already left the user's hands as far as the box is
      concerned, so it sits on the transcript's side of it. Outside the render ternary below, not a
      branch of it — like SubagentPanel it accompanies whatever is mounted there
      rather than replacing it, so the depth stays visible while a panel or an ApprovalBox owns the
      keyboard. `noPanelOpen` is what tells it its keys are dead in that state, so it can drop the
      key legend rather than name keys that will not reach it. It draws nothing at depth zero, and
      the transcript box above is `flexGrow`, so the rows it does draw come out of the scrollbox
      with no height budget to thread through here. */}
      <QueueBlock
        queue={state.queue}
        width={width}
        noPanelOpen={noPanelOpen}
        onSubmit={onSubmit ?? (() => {})}
        dispatch={dispatch}
      />
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
      ) : state.pendingSkills !== undefined ? (
        <SkillsPanel
          rows={state.pendingSkills.rows}
          onSkillRun={(name) => {
            dispatch({ type: "skills-closed" });
            onSkillRun?.(name);
          }}
          onSkillsClose={() => dispatch({ type: "skills-closed" })}
        />
      ) : state.pendingMemory !== undefined ? (
        <MemoryPanel
          rows={state.pendingMemory.rows}
          onDiff={onMemoryDiff}
          onApprove={onMemoryApprove}
          onReject={onMemoryReject}
          onMemoryClose={() => dispatch({ type: "memory-closed" })}
        />
      ) : state.pendingMcp !== undefined ? (
        <McpPanel
          rows={state.pendingMcp.rows}
          onConnect={onMcpConnect}
          onTrust={onMcpTrust}
          onRemove={onMcpRemove}
          onAuth={onMcpAuth}
          onAuthCancel={onMcpAuthCancel}
          onMcpClose={() => dispatch({ type: "mcp-closed" })}
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
          banner={splashBanner}
          onLogin={onSplashLogin}
          onSignup={onSplashSignup}
          onContinue={onSplashContinue}
        />
      ) : onSubmit === undefined &&
        onPreSessionSubmit !== undefined &&
        state.splashDone &&
        queued === undefined ? (
        // The pre-session window is not dead time — the models.dev fetch on the way to
        // `prepareSession` can hold it for seconds, and every harness this was modelled on takes
        // input across it. The box is live and the note says where a submitted line goes.
        <>
          <text fg={theme.muted}>starting session… your message sends when it is ready</text>
          <InputBox
            onSubmit={(value) => {
              const task = value.trim();
              if (task.length === 0) return;
              setQueued(task);
              dispatch({ type: "transcript-append", role: "user", line: value });
              onPreSessionSubmit(task);
            }}
            onQuit={onQuit}
          />
        </>
      ) : onSubmit === undefined && state.splashDone && queued !== undefined ? (
        // One task, not a queue: a second line typed here would silently replace the first, since
        // only one value survives to the session mount. The box goes away instead of lying about it.
        <box flexDirection="row" {...FRAME}>
          <text fg={theme.muted}>queued — sending when the session is ready</text>
        </box>
      ) : onSubmit === undefined ? (
        // Nothing is wired behind this mount yet. The welcome splash and the guided setup
        // (routes/setup/) render this same component before a session exists, and both keep it on
        // screen for as long as the startup work behind them takes — the models.dev fetch on the
        // way to `prepareSession` alone can hold it for seconds. Rendering InputBox here swallows a
        // task typed in that window: it echoes the text and then drops it on Enter, because there is
        // nowhere to send it. Same FRAME as InputBox so the mode row below does not jump
        // when the real session mounts.
        <box flexDirection="row" {...FRAME}>
          <text fg={theme.muted}>starting session…</text>
        </box>
      ) : (
        <>
          <InputBox
            onSubmit={onSubmit}
            onQuit={onQuit}
            // Only while a turn is actually in flight and no queue row is open in its own editor.
            // Undefined otherwise, so the Escape that dismisses a completion popup or closes a panel
            // never reaches cli.ts at all — cli.ts guards this again on its own side, because an
            // Escape delivered with signals.ts's cancel slot empty kills the process rather than
            // no-opping. While a row IS being edited this box is inert anyway; passing undefined as
            // well states the intent rather than relying on that.
            onEscape={state.turn !== undefined && !state.queue.editing ? onEscape : undefined}
            prefill={state.pendingInputPrefill}
            onPrefillConsumed={() => dispatch({ type: "input-prefill-consumed" })}
            onEmptyDown={
              state.subagents.length > 0 && !state.queue.editing && !scrolledUp
                ? () => dispatch({ type: "subagent-panel-focus" })
                : undefined
            }
            arrowsReservedRef={arrowsReservedRef}
            // `state.queue.editing` joins the two subagent conditions: while a queue row holds its own
            // InputBox, two of them are mounted at once, and OpenTUI delivers every keypress to every
            // mounted handler — so without this a typed character lands in the row's editor AND in
            // this box. `inert` no-ops exactly the set that must not double up (printables, paste,
            // Enter, Ctrl-D) while keeping this mount, and so whatever draft was already typed here,
            // alive. It deliberately still fires `onEmptyDown`, which is why that prop is suppressed
            // above too: a Down pressed inside the row editor would otherwise hand the keyboard to
            // the subagent roster mid-edit.
            inert={
              state.subagentPanelFocus ||
              state.pendingChildView !== undefined ||
              state.queue.editing
            }
            completionSources={getCompletionSources?.()}
          />
        </>
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
          {showModeHint && <text fg={theme.muted}>{MODE_CYCLE_HINT}</text>}
          <text fg={theme.muted}>{modeDetail}</text>
        </box>
        <box flexDirection="row" gap={1}>
          {/* `rightSideText`, not a re-check of `scrolledUp && !pagingPanelOpen` (`pagingPanelOpen`
          matters here too: while one of those panels is open, End is swallowed by the exact same
          gate that puts on the transcript-scroll keys above — the banner would otherwise keep
          telling the user to press a key that does nothing until they close the panel first, and
          behind an approval, where the keys DO work, it has to appear) — reusing the already-computed
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
