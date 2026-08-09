// The decision half of the decision/presentation split (research-spec) for the four slash
// commands: each function here decides what happened and returns it, and prints nothing itself —
// no saveSession, no console.log/print*. That is what lets the same decision serve both the
// existing non-interactive path (console.log the message) and the TUI path (dispatch it into the
// live transcript) from one implementation, mirroring ApprovalPrompt's two-implementation shape.
//
// checkpointTarget/steps mirror cli.ts's own private helpers (cli.ts:100-102, :144-153) rather
// than importing them — cli.ts is not touched in this phase (Phase 2, additive-only). Phase 5's
// wiring pass is expected to have cli.ts call through to these instead of keeping its own copies.
import type { ModelMessage } from "ai";
import {
  appendBarrier,
  checkpointStoreDir,
  type RestoreResult,
  restoreCommit,
  rewindConversation,
  undoFiles,
} from "../checkpoint/checkpoint";
import { projectRoot } from "../checkpoint/shadowGit";
import { cycleMode } from "../gate/gate";
import type { SessionState } from "../session/session";

export type CommandDirs = { sessionsDir: string; checkpointsDir: string };

function checkpointTarget(
  session: SessionState<ModelMessage>,
  dirs: CommandDirs,
): { storeDir: string; worktree: string } {
  const worktree = projectRoot(session.cwd);
  return { storeDir: checkpointStoreDir(dirs.checkpointsDir, worktree), worktree };
}

function steps(args: string[]): number {
  return args[0] === undefined ? 1 : Number(args[0]);
}

export function applyModeCycle(session: SessionState<ModelMessage>): {
  next: SessionState<ModelMessage>;
  message: string;
} {
  const next = { ...session, permissionMode: cycleMode(session.permissionMode) };
  return { next, message: `Session ${next.id}: permission mode is now ${next.permissionMode}` };
}

export function applyUndo(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
): { next: SessionState<ModelMessage>; plan: RestoreResult; message: string } {
  const stepCount = steps(args);
  const plan = undoFiles({
    ...checkpointTarget(session, dirs),
    sessionId: session.id,
    steps: stepCount,
    onPlan: () => {},
  });
  const message =
    plan.restored.length === 0 && plan.deleted.length === 0
      ? `Already at checkpoint ${stepCount}; no file changed.`
      : `Undid to checkpoint ${stepCount}.`;
  return { next: session, plan, message };
}

export function applyRestore(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
): { next: SessionState<ModelMessage>; plan: RestoreResult; message: string } {
  const commit = args[0] ?? "";
  const plan = restoreCommit({
    ...checkpointTarget(session, dirs),
    sessionId: session.id,
    commit,
    onPlan: () => {},
  });
  const message =
    plan.restored.length === 0 && plan.deleted.length === 0
      ? `Already at ${commit}; no file changed.`
      : `Restored ${commit}.`;
  return { next: session, plan, message };
}

export function applyRewind(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
): { next: SessionState<ModelMessage>; message: string } {
  const { storeDir } = checkpointTarget(session, dirs);
  const { rewindTo } = rewindConversation({ storeDir, sessionId: session.id, steps: steps(args) });
  const kept = Math.min(rewindTo, session.messages.length);
  const dropped = session.messages.length - kept;
  const next = { ...session, messages: session.messages.slice(0, kept) };
  if (dropped > 0) appendBarrier(storeDir, session.id, "rewind");
  return {
    next,
    message: `Session ${next.id}: dropped ${dropped} message(s), ${kept} remain. No file was touched.`,
  };
}
