// The shared-state home the research spec's Constraint 4 requires: driveLoop and all four slash
// commands dispatch into this one reducer rather than each holding a separate copy. Zero Ink/React
// import — a plain, standalone reducer, testable without a terminal.
import type { ModelMessage } from "ai";
import { toolAllowedLine, toolResultLine } from "../cli/output";
import type { PermissionMode } from "../gate/gate";
import type { LoopEvent } from "../loop/loop";
import type { SessionState } from "../session/session";

export type TuiState = {
  session: SessionState<ModelMessage>;
  // Append-only committed lines — the <Static> transcript's source in Phase 4.
  transcript: string[];
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
  // rendered with theme.ts's `error` role rather than left to vanish silently. Not auto-cleared:
  // it stays visible until the next command error replaces it or the session ends.
  commandError: string | undefined;
  // Findings 1+5 (thermo-nuclear structural review, round 6): the TUI-native ApprovalPrompt's own
  // live state — set when runTui's tuiApprovalPrompt is called (a write-tool call reached the
  // gate), cleared once the user answers. `offersAlways` mirrors makeApprovalPrompt's own
  // PERSISTABLE_TOOLS check, computed once at request time rather than re-derived at render time.
  // App.tsx renders its own ApprovalBox instead of InputBox whenever this is set — mutually
  // exclusive, matching how the non-interactive CLI already blocks on this same question before
  // reading anything else from stdin.
  pendingApproval: { toolName: string; args: unknown; offersAlways: boolean } | undefined;
};

function modeIndicator(mode: PermissionMode): string {
  return `[${mode}]`;
}

export function initialTuiState(session: SessionState<ModelMessage>): TuiState {
  return {
    session,
    transcript: [],
    streaming: "",
    status: "",
    modeIndicator: modeIndicator(session.permissionMode),
    pendingTool: undefined,
    commandError: undefined,
    pendingApproval: undefined,
  };
}

export type TuiAction =
  | { type: "session-updated"; session: SessionState<ModelMessage> }
  | { type: "transcript-append"; line: string }
  | { type: "loop-event"; event: LoopEvent }
  | { type: "command-error"; message: string }
  | { type: "approval-requested"; toolName: string; args: unknown; offersAlways: boolean }
  | { type: "approval-resolved" };

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
      return pushLine(state, action.line);
    case "loop-event":
      return applyLoopEvent(state, action.event);
    case "command-error":
      return { ...state, commandError: action.message };
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
  }
}

// Commits any pending streamed text as its own transcript line before appending `line`, so a
// tool-call/done/error that arrives mid-stream does not discard the model's partial answer.
function pushLine(state: TuiState, line: string): TuiState {
  const transcript =
    state.streaming.length > 0 ? [...state.transcript, state.streaming] : state.transcript;
  return { ...state, transcript: [...transcript, line], streaming: "" };
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
