import type { ChildEventPayload } from "../../subagents/dispatch";
import { estimateTokens } from "../util/format";
import { type Dispatch, type TuiAction, type TuiState, tuiReducer } from "./reducer";

export const STREAM_TOKEN_PAINT_MS = 150;

type ChildMeta = Omit<ChildEventPayload, "event">;

export function createStreamDispatch(setState: (updater: (state: TuiState) => TuiState) => void): {
  dispatch: Dispatch;
  getPendingLiveOutputEstimate: () => number;
  getPendingReasoning: () => string;
  subscribe: (listener: () => void) => () => void;
} {
  let parentBuf = "";
  let pendingLive = 0;
  let reasoningBuf = "";
  let reasoningStartedAt: number | undefined;
  const childBufs = new Map<string, string>();
  const childMeta = new Map<string, ChildMeta>();
  const listeners = new Set<() => void>();
  let paintTimer: ReturnType<typeof setTimeout> | undefined;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const schedulePaint = (): void => {
    if (paintTimer !== undefined) return;
    paintTimer = setTimeout(() => {
      paintTimer = undefined;
      notify();
    }, STREAM_TOKEN_PAINT_MS);
  };

  const clearPaintTimer = (): void => {
    if (paintTimer === undefined) return;
    clearTimeout(paintTimer);
    paintTimer = undefined;
  };

  const drainThen = (action: TuiAction): void => {
    clearPaintTimer();
    // Snapshot here, not inside the updater: React may defer `setState` until the next
    // macrotask, and a later text-delta would otherwise be visible to already-queued
    // updaters (transcript-append flushes `streaming`, which would commit buffered
    // answer text as a transcript row before the action this drain belongs to).
    const parentDrain = parentBuf;
    parentBuf = "";
    pendingLive = 0;
    const reasoningDrain = reasoningBuf;
    const reasoningStart = reasoningStartedAt;
    reasoningBuf = "";
    reasoningStartedAt = undefined;
    const childDrains: { meta: ChildMeta; text: string }[] = [];
    for (const [childId, buf] of childBufs) {
      if (buf.length === 0) continue;
      const meta = childMeta.get(childId);
      if (meta === undefined) continue;
      childDrains.push({ meta, text: buf });
    }
    childBufs.clear();
    setState((state) => {
      let next = state;
      if (reasoningDrain.length > 0 && reasoningStart !== undefined) {
        next = tuiReducer(next, {
          type: "reasoning-flushed",
          text: reasoningDrain,
          startedAt: reasoningStart,
        });
      }
      if (parentDrain.length > 0) {
        next = tuiReducer(next, {
          type: "loop-event",
          event: { type: "text-delta", text: parentDrain },
        });
      }
      for (const { meta, text } of childDrains) {
        next = tuiReducer(next, {
          type: "subagent-child-event",
          ...meta,
          event: { type: "text-delta", text },
        });
      }
      return tuiReducer(next, action);
    });
    notify();
  };

  const dispatch: Dispatch = (action) => {
    if (action.type === "loop-event" && action.event.type === "text-delta") {
      parentBuf += action.event.text;
      pendingLive += estimateTokens(action.event.text);
      schedulePaint();
      return;
    }
    if (action.type === "loop-event" && action.event.type === "reasoning-delta") {
      if (action.event.text.length === 0) return;
      if (reasoningStartedAt === undefined) reasoningStartedAt = Date.now();
      reasoningBuf += action.event.text;
      schedulePaint();
      return;
    }
    if (action.type === "subagent-child-event") {
      childMeta.set(action.childId, {
        childId: action.childId,
        role: action.role,
        goal: action.goal,
        model: action.model,
        provider: action.provider,
        inherited: action.inherited,
      });
      if (action.event.type === "text-delta") {
        childBufs.set(action.childId, (childBufs.get(action.childId) ?? "") + action.event.text);
        return;
      }
    }
    drainThen(action);
  };

  return {
    dispatch,
    getPendingLiveOutputEstimate: () => pendingLive,
    getPendingReasoning: () => reasoningBuf,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
