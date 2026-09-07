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
import { fileChangeFromTool, fileChangePlainText, sameHunk } from "../../fileChange";
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

export type ConfigPanelState =
  | { step: "list"; rows: ConfigRow[]; selected: number }
  | { step: "enter-value"; key: string; error?: string; busy: boolean }
  | { step: "confirm-unset"; key: string };

export type PermissionsPanelState =
  | { step: "list"; rows: PermissionRow[]; selected: number }
  | { step: "confirm-remove"; tool: string };

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

// id is a React key so dropping a row above an open editor does not remount it and wipe half-typed text.
export type QueuedMessage = { id: string; text: string };

export type MessageQueue = {
  items: QueuedMessage[];
  selected: number;
  editing: boolean;
};

export type TuiState = {
  session: SessionState<ModelMessage>;
  transcript: TranscriptEntry[];
  streaming: string;
  status: string;
  turn: { startedAt: number; tokens: TokenProgress } | undefined;
  pendingTool: { name: string; args: unknown } | undefined;
  toolActivity: ToolActivityEntry[];
  commandError: string | undefined;
  pendingApproval:
    | {
        toolName: string;
        args: unknown;
        offersAlways: boolean;
        classifierReason?: string;
      }
    | undefined;
  pendingAskUser: AskPrompt | undefined;
  pendingModelPicker: { entries: ModelPickerEntry[] } | undefined;
  // A pty chunk can carry filter text, a terminator, and further keystrokes; leftoverInput is that tail so closing the panel does not drop them.
  pendingInputPrefill: string | undefined;
  pendingSetup: SetupState | undefined;
  authOffer: boolean;
  pendingAuth: AuthPanelState | undefined;
  pendingConfig: ConfigPanelState | undefined;
  pendingPermissions: PermissionsPanelState | undefined;
  pendingSkills: { rows: SkillsPanelRow[] } | undefined;
  pendingMcp: { rows: readonly McpPanelRow[] } | undefined;
  pendingMemory: { rows: readonly MemoryPanelRow[] } | undefined;
  pendingEffort: EffortPanelState | undefined;
  pendingChrome: ChromePanelState | undefined;
  plan: PlanOverlay;
  pendingSplash: boolean;
  splashDone: boolean;
  route: ResolvedRoute | undefined;
  config: Record<string, string>;
  queue: MessageQueue;
  checklist: TodoList;
  subagents: ChildView[];
  subagentPanelFocus: boolean;
  subagentPanelSelectedId: string | undefined;
  pendingChildView: string | undefined;
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

const EMPTY_REASONING: ReasoningState = Object.freeze({ expanded: false });

const EMPTY_TRANSCRIPT: Readonly<
  Pick<TuiState, "transcript" | "streaming" | "toolActivity" | "reasoning">
> = Object.freeze({
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

const EMPTY_QUEUE: MessageQueue = Object.freeze({
  items: Object.freeze([] as QueuedMessage[]) as QueuedMessage[],
  selected: 0,
  editing: false,
});

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
  | { type: "user-turn-committed"; messages: ModelMessage[] }
  | {
      type: "transcript-append";
      line: string;
      role?: TranscriptRole;
      flush?: boolean;
      muted?: boolean;
      markdown?: boolean;
    }
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
  | {
      type: "model-picker-resolved";
      pick?: { model: string; provider: ModelProvider; keyConfigured: boolean };
      route?: ResolvedRoute;
      leftoverInput?: string;
    }
  | { type: "input-prefill-consumed" }
  | { type: "setup-requested"; rows: SetupProviderRow[] }
  | { type: "setup-step"; state: SetupState }
  | { type: "setup-resolved"; leftoverInput?: string }
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
  | { type: "skills-requested"; rows: SkillsPanelRow[] }
  | { type: "skills-closed" }
  | { type: "mcp-requested"; rows: readonly McpPanelRow[] }
  | { type: "mcp-closed" }
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
  | { type: "route-updated"; route: ResolvedRoute }
  | { type: "config-updated"; config: Record<string, string> }
  | { type: "turn-started"; startedAt: number; inputEstimate: number }
  | { type: "turn-ended" }
  | { type: "reasoning-flushed"; text: string; startedAt: number }
  | { type: "reasoning-toggled" }
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
      return commitFileChange(
        {
          ...child,
          toolActivity: recordResult(
            child.toolActivity,
            event.name,
            child.currentTool?.args,
            event.result,
          ),
          currentTool: undefined,
        },
        event.name,
        child.currentTool?.args,
        event.result,
      );
    case "permission-denied":
      return {
        ...child,
        toolActivity: recordDenial(child.toolActivity, event.name, event.reason),
        currentTool: undefined,
      };
    case "error": {
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
      return {
        ...flushToolActivity(flushStreaming(settleReasoning(state, Date.now()))),
        turn: undefined,
      };
    case "reasoning-flushed":
      return openOrAppendReasoning(state, action.text, action.startedAt);
    case "reasoning-toggled":
      return toggleReasoning(state);
    case "queue-appended":
      return {
        ...state,
        queue: normalizeQueue(
          [...state.queue.items, { id: action.id, text: action.text }],
          state.queue.selected,
          state.queue.editing,
        ),
      };
    case "queue-selection-moved":
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
      if (state.queue.editing || state.queue.items.length === 0) return state;
      return { ...state, queue: { ...state.queue, editing: true } };
    case "queue-edit-committed": {
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

function flushStreaming(state: TuiState): TuiState {
  if (state.streaming.length === 0) return state;
  return {
    ...state,
    transcript: [...state.transcript, { role: "assistant", text: state.streaming }],
    streaming: "",
  };
}

function lastFileChangeThisTurn(
  transcript: TranscriptEntry[],
): { index: number; change: NonNullable<TranscriptEntry["fileChange"]> } | undefined {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const entry = transcript[index];
    if (entry === undefined) continue;
    if (entry.role === "user") return undefined;
    if (entry.kind === "file-change" && entry.fileChange !== undefined) {
      return { index, change: entry.fileChange };
    }
  }
  return undefined;
}

function commitFileChange<T extends { transcript: TranscriptEntry[] }>(
  state: T,
  name: string,
  args: unknown,
  result: unknown,
): T {
  const change = fileChangeFromTool(name, args, result);
  if (change === undefined) return state;
  const last = lastFileChangeThisTurn(state.transcript);
  if (last !== undefined && sameHunk(last.change, change)) return state;
  const entry: TranscriptEntry = {
    role: "system",
    text: fileChangePlainText(change),
    kind: "file-change",
    fileChange: change,
  };
  if (last !== undefined && last.change.title === "Edit" && change.title === "Edit") {
    const transcript = state.transcript.slice();
    transcript[last.index] = entry;
    return { ...state, transcript };
  }
  return { ...state, transcript: [...state.transcript, entry] };
}

function flushToolActivity(state: TuiState): TuiState {
  const rows: TranscriptEntry[] = [];
  const summary = formatToolSummary(state.toolActivity);
  if (summary !== undefined) {
    rows.push({ role: "system", text: summary, muted: true, kind: "tool-summary" });
  }
  return {
    ...state,
    transcript: rows.length === 0 ? state.transcript : [...state.transcript, ...rows],
    toolActivity: [],
  };
}

// vercel/ai LanguageModelUsage may omit inputTokens, outputTokens, or both; fold each defined field and treat a missing sibling as a gap that later usage cannot fill.
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
  return transcript.map((entry) => {
    if (entry.kind !== "reasoning") return entry;
    if (entry.body === undefined && entry.expanded !== true) return entry;
    const nextEntry: TranscriptEntry = {
      ...entry,
      expanded: false,
      text: formatReasoningCaret(false, entry.elapsedMs ?? 0),
    };
    delete nextEntry.body;
    return nextEntry;
  });
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
            exact: false,
          },
        },
      };
    }
    case "reasoning-delta":
      return openOrAppendReasoning(state, event.text, Date.now());
    case "tool-call": {
      const settled = settleReasoning(state, Date.now());
      const flushed = flushStreaming(settled);
      return commitFileChange(
        {
          ...flushed,
          status:
            event.name === "dispatch_subagents" || event.name === TODO_TOOL_NAME
              ? ""
              : `Running ${event.name}…`,
          pendingTool: { name: event.name, args: event.args },
          toolActivity: recordCall(flushed.toolActivity, event.name, event.args),
        },
        event.name,
        event.args,
        undefined,
      );
    }
    case "tool-result": {
      const nextList = event.name === TODO_TOOL_NAME ? parseTodoList(event.result) : undefined;
      return commitFileChange(
        {
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
        },
        event.name,
        state.pendingTool?.args,
        event.result,
      );
    }
    case "permission-denied":
      return {
        ...state,
        toolActivity: recordDenial(state.toolActivity, event.name, event.reason),
        status: "",
        pendingTool: undefined,
      };
    case "tool-allowed":
      return {
        ...pushLine(state, toolAllowedLine(event.name)),
        status: "",
      };
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
    case "usage":
      return state.turn === undefined
        ? state
        : {
            ...state,
            turn: { ...state.turn, tokens: reconcileUsage(state.turn.tokens, event.usage) },
          };
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
