/** @jsxImportSource @opentui/react */
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { findCatalogEntry, type ModelCatalog, type ModelProvider } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { isCtrlOPlanToggle, isShiftTabModeCycle } from "../cli/commandCatalog";
import { ALLOW_UNSANDBOXED_COMMANDS_KEY, configBoolean, configValue } from "../config/config";
import type { HumanReply } from "../ask-user/types";
import type { PermissionMode } from "../gate/gate";
import type { ApprovalAnswer } from "../loop/loop";
import type { McpLoginResult } from "../mcp/login";
import type { McpCatalog } from "../mcp/types";
import {
  isPlanOverlayOn,
  isPlanPanelOpen,
  type PlanAnswers,
  type PlanReviewDecision,
} from "../plan/mode";
import { appliedReasoningEffort, resolveReasoningEffort } from "../provider/reasoning";
import type { ResolvedRoute } from "../provider/routing";
import { formatSandboxIndicator, idleSandboxTier } from "../sandbox/policy";
import type { SessionState } from "../session/session";
import type { ChromeTabId } from "./chrome/tabs";
import { ApprovalBox } from "./components/ApprovalBox";
import { AskUserPanel } from "./components/AskUserPanel";
import { ChildTranscript } from "./components/ChildTranscript";
import { InputBox } from "./components/InputBox";
import { ModelPicker } from "./components/ModelPicker";
import { PlanQuestionsPanel } from "./components/PlanQuestionsPanel";
import { PlanReviewPanel } from "./components/PlanReviewPanel";
import { ChecklistBlock } from "./components/ChecklistBlock";
import { QueueBlock } from "./components/QueueBlock";
import { SubagentPanel } from "./components/SubagentPanel";
import { indentReasoningBody, TranscriptList } from "./components/TranscriptList";
import { TurnStatus } from "./components/TurnStatus";
import { ChromePanel } from "./routes/chrome/ChromePanel";
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
import { theme } from "./theme/theme";
import { ErrorLine } from "./ui/ErrorLine";
import { approvalCopy } from "./util/approvalCopy";
import type { CompletionSource } from "./util/completion";
import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  FALLBACK_CHROME_ROWS,
  formatModeDetail,
  formatRouteLabelFromResolved,
  MODE_CYCLE_HINT,
  MODE_LABEL,
  modeRowHintVisible,
  PLAN_MODE_LABEL,
  PLAN_MODE_LEAVE_HINT,
} from "./util/format";
import { quantizeScrollTop } from "./util/visibleTranscriptWindow";

export type AppProps = {
  session: SessionState<ModelMessage>;
  route: ResolvedRoute | undefined;
  catalog: ModelCatalog | undefined;
  config: Record<string, string>;
  connectDispatch?: (dispatch: Dispatch) => void;
  onSubmit?: (value: string) => void;
  onSessionChange?: (session: SessionState<ModelMessage>) => void;
  onQuit?: () => void;
  onEscape?: () => void;
  // A second stdin consumer would race the OpenTUI renderer's raw-mode ownership.
  onApprovalAnswer?: (answer: ApprovalAnswer) => void;
  onAskUserAnswered?: (reply: HumanReply) => void;
  onPlanQuestionsAnswered?: (answers: PlanAnswers) => void;
  onPlanReview?: (decision: PlanReviewDecision) => void;
  // leftoverInput is text after a terminator in the same pty chunk as the pick.
  onModelSelected?: (
    pick: { model: string; provider: ModelProvider; keyConfigured: boolean },
    leftoverInput?: string,
  ) => void;
  onModelPickerCancel?: () => void;
  onSetupSelect?: (row: SetupProviderRow) => void;
  onSetupKeyEntered?: (provider: ModelProvider, value: string) => void;
  onSetupRemove?: (row: SetupProviderRow) => void;
  onSetupBack?: () => void;
  onSetupClose?: (leftoverInput?: string) => void;
  onAuthResolved?: () => void;
  onConfigSelect?: (key: string) => void;
  onConfigValueEntered?: (key: string, value: string) => void;
  onConfigUnset?: (key: string) => void;
  onConfigBack?: () => void;
  onConfigClose?: (leftoverInput?: string) => void;
  onPermissionsRemove?: (tool: string) => void;
  onPermissionsBack?: () => void;
  onPermissionsClose?: (leftoverInput?: string) => void;
  onEffortSelected?: (tier: string, leftoverInput?: string) => void;
  onEffortCancel?: (leftoverInput?: string) => void;
  onSkillRun?: (name: string) => void;
  onMcpConnect?: (
    name: string,
  ) => Promise<{ ok: true; catalog: McpCatalog } | { ok: false; message: string }>;
  onMcpTrust?: (catalog: McpCatalog) => void;
  onMcpRemove?: (name: string) => void;
  onMcpAuth?: (name: string) => Promise<McpLoginResult>;
  onMcpAuthCancel?: () => void;
  onMemoryDiff?: (id: string) => string[];
  onMemoryApprove?: (id: string) => void;
  onMemoryReject?: (id: string) => void;
  onChromeTab?: (tab: ChromeTabId) => void;
  onChromeClose?: (leftoverInput?: string) => void;
  getCompletionSources?: () => readonly CompletionSource[];
  showSplash?: boolean;
  authOffer?: boolean;
  onSplashLogin?: () => void;
  onSplashSignup?: () => void;
  onSplashContinue?: () => void;
  splashBanner?: SplashBannerInfo;
  onPreSessionSubmit?: (task: string) => void;
  onCycleMode?: () => void;
  onTogglePlan?: () => void;
  // When set, the mode indicator must show auto and Shift+Tab must be inert, matching the gate override.
  skipPermissions?: boolean;
  confinementAvailable?: boolean;
};

// A pty can report width 0 before the window-size ioctl; || treats 0 like missing.
function resolveWidth(columns: number): number {
  return columns || DEFAULT_COLUMNS;
}

// A pty can report height 0 before the window-size ioctl; || treats 0 like missing.
function resolveHeight(rows: number): number {
  return rows || DEFAULT_ROWS;
}

// Below this width, stacked with the assistant bullet gutter, OpenTUI markdown fails to render at 4–5 columns.
const TRANSCRIPT_PADDING_MIN_WIDTH = 20;

function WritePreview({ name, args }: { name: string; args: unknown }) {
  const copy = approvalCopy(name, args);
  return (
    <box {...FRAME} flexDirection="column" flexShrink={0}>
      <text fg={theme.text} flexShrink={0} wrapMode="none" truncate>
        {copy.headline}
      </text>
      {copy.detail.length > 0 && (
        <text fg={theme.muted} flexShrink={0} wrapMode="none" truncate>
          {copy.detail}
        </text>
      )}
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
  onAskUserAnswered,
  onPlanQuestionsAnswered,
  onPlanReview,
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
  onChromeTab,
  onChromeClose,
  getCompletionSources,
  onSplashLogin,
  onSplashSignup,
  onSplashContinue,
  splashBanner,
  onPreSessionSubmit,
  onCycleMode,
  onTogglePlan,
  skipPermissions,
  confinementAvailable = false,
  showSplash,
  authOffer,
}: AppProps) {
  const [state, setState] = useState(() =>
    initialTuiState(session, { route, config, showSplash, authOffer }),
  );
  const stream = useMemo(() => createStreamDispatch(setState), []);
  const dispatch = stream.dispatch;
  const sessionBanner =
    splashBanner === undefined || state.route === undefined
      ? splashBanner
      : {
          ...splashBanner,
          model: state.route.model,
          provider: state.route.provider,
          via: formatRouteLabelFromResolved(state.route),
        };
  const [pendingReasoning, setPendingReasoning] = useState("");
  useEffect(
    () => stream.subscribe(() => setPendingReasoning(stream.getPendingReasoning())),
    [stream],
  );
  const { width: rawWidth, height: rawRows } = useTerminalDimensions();
  const width = resolveWidth(rawWidth);
  const rows = resolveHeight(rawRows);
  const planOn = isPlanOverlayOn(state.plan);
  const displayMode: PermissionMode = planOn
    ? "read-only"
    : skipPermissions === true
      ? "auto"
      : state.session.permissionMode;
  const allowUnsandboxedCommands = configBoolean(
    configValue(ALLOW_UNSANDBOXED_COMMANDS_KEY, state.config),
  );
  const indicatorText = planOn ? PLAN_MODE_LABEL : MODE_LABEL[displayMode];
  const sandboxSuffix = formatSandboxIndicator(
    idleSandboxTier({ available: confinementAvailable }, allowUnsandboxedCommands),
  );

  const transcriptRef = useRef<ScrollBoxRenderable>(null);
  const arrowsReservedRef = useRef(false);
  // Null until the first onSizeChange; OpenTUI can measure this box to 0, and scrollbox height 0 paints nothing.
  const [measuredRows, setMeasuredRows] = useState<number | null>(null);
  const [queued, setQueued] = useState<string | undefined>(undefined);
  const transcriptHeight = Math.max(1, measuredRows ?? rows - FALLBACK_CHROME_ROWS);
  const { turn } = state;
  const scrollboxHeight = Math.max(0, transcriptHeight - (turn !== undefined ? 1 : 0));

  // OpenTUI stickyStart can re-engage on resize or content shrink without a scroll-position change; mirror scrolledUp from scrollbar change plus viewport/content resize and root layout-changed.
  const [scrolledUp, setScrolledUp] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const renderer = useRenderer();
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    // OpenTUI layout-changed fires before the scrollbox refreshes scrollHeight; viewport and content resize emit after that refresh.
    const sync = () => {
      const maxScrollTop = Math.max(0, el.scrollHeight - el.viewport.height);
      setScrolledUp(el.scrollTop < maxScrollTop);
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

  const pagingPanelOpen =
    state.pendingSplash ||
    (state.pendingApproval === undefined &&
      (state.pendingAskUser !== undefined ||
        isPlanPanelOpen(state.plan) ||
        state.pendingModelPicker !== undefined ||
        state.pendingSetup !== undefined ||
        state.pendingAuth !== undefined ||
        state.pendingConfig !== undefined ||
        state.pendingPermissions !== undefined ||
        state.pendingEffort !== undefined ||
        state.pendingSkills !== undefined ||
        state.pendingMcp !== undefined ||
        state.pendingMemory !== undefined ||
        state.pendingChrome !== undefined));

  const noPanelOpen = !pagingPanelOpen && state.pendingApproval === undefined;

  const rightSideText = scrolledUp && !pagingPanelOpen ? "↑ scrolled — End to follow" : "";
  const rawRightSideWidth =
    rightSideText.length +
    (rightSideText.length > 0 && state.status.length > 0 ? 1 : 0) +
    state.status.length;
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
  const leftover = Math.max(0, remaining - indicatorText.length);
  const packedSandbox = sandboxSuffix.length <= leftover ? sandboxSuffix : "";
  const modeDetail = formatModeDetail(state.route, leftover - packedSandbox.length, effortTier);
  const modeHint = planOn ? PLAN_MODE_LEAVE_HINT : MODE_CYCLE_HINT;
  const showModeHint = modeRowHintVisible(
    remaining,
    indicatorText.length,
    packedSandbox.length + modeDetail.length,
    modeHint.length,
  );

  // OpenTUI delivers each keypress to every registered handler.
  useKeyboard((key) => {
    if (!noPanelOpen) return;
    if (isShiftTabModeCycle(key) && skipPermissions !== true && !planOn) onCycleMode?.();
    if (isCtrlOPlanToggle(key)) onTogglePlan?.();
    if (key.ctrl && key.name === "t") dispatch({ type: "reasoning-toggled" });
  });

  // The scrollbox has no focused prop, so OpenTUI's own handleKeyPress never fires. With mouse reporting off, a wheel notch arrives as Up/Down.
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
    <box flexDirection="column" height={rows}>
      {/* OpenTUI scrollbox flexGrow sizing corrupts sibling rows; Yoga also sizes this wrapper from children unless flexBasis is 0. Measure the wrapper (flexBasis 0, overflow hidden) and pass a definite height. */}
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
        {/* Hide the scrollbar: with mouse reporting off it cannot be used, and its block glyphs copy into selections. visible:false latches OpenTUI _manualVisibility so later content cannot show it again. */}
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
              {sessionBanner !== undefined && <SplashBanner info={sessionBanner} />}
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
                    marginTop={gapBefore(
                      state.transcript.at(-1)?.role,
                      "system",
                      state.transcript.at(-1)?.kind,
                    )}
                  >
                    {indentReasoningBody((state.reasoning.live?.text ?? "") + pendingReasoning)}
                  </text>
                )}
              {renderLiveToolActivity(state.toolActivity).map((line, index) => (
                <text
                  key={index}
                  fg={theme.muted}
                  marginTop={
                    index === 0
                      ? gapBefore(
                          state.transcript.at(-1)?.role,
                          "system",
                          state.transcript.at(-1)?.kind,
                        )
                      : 0
                  }
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
        {turn !== undefined && (
          <TurnStatus
            key={turn.startedAt}
            startedAt={turn.startedAt}
            tokenProgress={turn.tokens}
            pendingLiveOutputEstimate={stream.getPendingLiveOutputEstimate}
            subscribePendingLive={stream.subscribe}
            thinking={(state.reasoning.live?.text.length ?? 0) > 0 || pendingReasoning.length > 0}
            thinkingExpanded={state.reasoning.expanded}
            toolInFlight={state.pendingTool !== undefined}
          />
        )}
      </box>
      {state.pendingTool !== undefined &&
        state.pendingTool.name !== "todo" &&
        state.pendingTool.name !== "edit" &&
        !(state.pendingTool.name === "dispatch_subagents" && state.subagents.length > 0) &&
        (state.pendingTool.name === "write_file" ? (
          <WritePreview name={state.pendingTool.name} args={state.pendingTool.args} />
        ) : (
          <text fg={theme.muted}>
            {summarizeArgs(state.pendingTool.name, state.pendingTool.args)}
          </text>
        ))}
      <ErrorLine message={state.commandError} />
      <ChecklistBlock items={state.checklist} />
      <QueueBlock
        queue={state.queue}
        width={width}
        noPanelOpen={noPanelOpen}
        onSubmit={onSubmit ?? (() => {})}
        dispatch={dispatch}
      />
      {state.pendingApproval !== undefined ? (
        <ApprovalBox
          pendingApproval={state.pendingApproval}
          onAnswer={onApprovalAnswer}
          onQuit={onQuit}
        />
      ) : state.pendingAskUser !== undefined ? (
        <AskUserPanel prompt={state.pendingAskUser} onAnswer={onAskUserAnswered} onQuit={onQuit} />
      ) : state.plan.kind === "clarifying" ? (
        <PlanQuestionsPanel
          questions={state.plan.questions}
          onAnswer={onPlanQuestionsAnswered}
          onQuit={onQuit}
        />
      ) : state.plan.kind === "reviewing" ? (
        <PlanReviewPanel plan={state.plan} onDecision={onPlanReview} onQuit={onQuit} />
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
      ) : state.pendingChrome !== undefined ? (
        <ChromePanel
          pendingChrome={state.pendingChrome}
          onChromeTab={onChromeTab}
          onChromeClose={onChromeClose}
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
        <box flexDirection="row" {...FRAME}>
          <text fg={theme.muted}>queued — sending when the session is ready</text>
        </box>
      ) : onSubmit === undefined ? (
        <box flexDirection="row" {...FRAME}>
          <text fg={theme.muted}>starting session…</text>
        </box>
      ) : (
        <>
          <InputBox
            onSubmit={onSubmit}
            onQuit={onQuit}
            onEscape={state.turn !== undefined && !state.queue.editing ? onEscape : undefined}
            prefill={state.pendingInputPrefill}
            onPrefillConsumed={() => dispatch({ type: "input-prefill-consumed" })}
            onEmptyDown={
              state.subagents.length > 0 && !state.queue.editing && !scrolledUp
                ? () => dispatch({ type: "subagent-panel-focus" })
                : undefined
            }
            arrowsReservedRef={arrowsReservedRef}
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
        <box flexDirection="row">
          <text fg={theme.mode[displayMode]}>
            {indicatorText}
            {packedSandbox}
          </text>
          {showModeHint && <text fg={theme.muted}>{modeHint}</text>}
          <text fg={theme.muted}>{modeDetail}</text>
        </box>
        <box flexDirection="row" gap={1}>
          {showRightSide && rightSideText.length > 0 && (
            <text fg={theme.muted}>{rightSideText}</text>
          )}
          {showRightSide && state.status.length > 0 && <text fg={theme.muted}>{state.status}</text>}
        </box>
      </box>
    </box>
  );
}
