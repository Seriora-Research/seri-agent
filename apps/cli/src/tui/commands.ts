// The decision half of the decision/presentation split (research-spec) for the four slash
// commands: each function here decides what happened and returns it, and prints nothing itself —
// no saveSession, no console.log/print*. That is what lets the same decision serve both the
// existing non-interactive path (console.log the message) and the TUI path (dispatch it into the
// live transcript) from one implementation, mirroring ApprovalPrompt's two-implementation shape.
//
// checkpointTarget is exported and reused by cli.ts's prepareSession — the one copy this module
// and cli.ts both call through to, rather than cli.ts keeping its own duplicate (it did, briefly,
// between Phase 2 and the fix that consolidated it here).
import type { ModelMessage } from "ai";
import {
  appendBarrier,
  checkpointStoreDir,
  type RestorePlan,
  type RestoreResult,
  restoreCommit,
  rewindConversation,
  undoFiles,
} from "../checkpoint/checkpoint";
import { projectRoot } from "../checkpoint/shadowGit";
import { cycleMode } from "../gate/gate";
import type { SessionState } from "../session/session";

export type CommandDirs = { sessionsDir: string; checkpointsDir: string };

// The session records the directory seri was started in, which is not necessarily the project —
// resolving the root here rather than at each call site is what keeps the live run and the three
// restoring commands addressing the same store, since the key is derived from it.
export function checkpointTarget(
  session: SessionState<ModelMessage>,
  dirs: CommandDirs,
): { storeDir: string; worktree: string } {
  const worktree = projectRoot(session.cwd);
  return { storeDir: checkpointStoreDir(dirs.checkpointsDir, worktree), worktree };
}

function steps(args: string[]): number {
  return args[0] === undefined ? 1 : Number(args[0]);
}

// "decide", not "apply": named to match undoCommand/restoreCommand/rewindCommand/cycleModeCommand
// (cli.ts) calling these to DECIDE the outcome, then handing it to a presenter — and to stop
// colliding with checkpoint/shadowGit.ts's own `applyRestore`, a different function (performs the
// removal pass) that this file's own former `applyRestore` name was one import away from.
export function decideModeCycle(session: SessionState<ModelMessage>): {
  next: SessionState<ModelMessage>;
  message: string;
} {
  const next = { ...session, permissionMode: cycleMode(session.permissionMode) };
  return { next, message: `Session ${next.id}: permission mode is now ${next.permissionMode}` };
}

// `onPlan` defaults to a no-op but is meant to be passed through from the caller's own presenter
// (cli.ts's CommandPresenter.onPlan) — undoFiles/restoreCommit call it synchronously with the
// diff/restored/deleted plan BEFORE the removal pass runs, which is what lets the console path
// restore output.ts's own documented guarantee ("printed before the restore happens, not after")
// instead of only being able to report the plan after the fact, from the final result.
export function decideUndo(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  onPlan: (plan: RestorePlan) => void = () => {},
): { next: SessionState<ModelMessage>; plan: RestoreResult; message: string } {
  const stepCount = steps(args);
  const plan = undoFiles({
    ...checkpointTarget(session, dirs),
    sessionId: session.id,
    steps: stepCount,
    onPlan,
  });
  const message =
    plan.restored.length === 0 && plan.deleted.length === 0
      ? `Already at checkpoint ${stepCount}; no file changed.`
      : `Undid to checkpoint ${stepCount}.`;
  return { next: session, plan, message };
}

export function decideRestore(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
  onPlan: (plan: RestorePlan) => void = () => {},
): { next: SessionState<ModelMessage>; plan: RestoreResult; message: string } {
  const commit = args[0] ?? "";
  const plan = restoreCommit({
    ...checkpointTarget(session, dirs),
    sessionId: session.id,
    commit,
    onPlan,
  });
  const message =
    plan.restored.length === 0 && plan.deleted.length === 0
      ? `Already at ${commit}; no file changed.`
      : `Restored ${commit}.`;
  return { next: session, plan, message };
}

export function decideRewind(
  session: SessionState<ModelMessage>,
  args: string[],
  dirs: CommandDirs,
): { next: SessionState<ModelMessage>; message: string; recordBarrier: () => void } {
  const { storeDir } = checkpointTarget(session, dirs);
  const { rewindTo } = rewindConversation({ storeDir, sessionId: session.id, steps: steps(args) });
  // Clamped, because an anchor can outlive the array it indexed: a previous /rewind truncated the
  // session and the messages that followed reused those indices. Slicing past the end is a silent
  // no-op, and reporting the anchor rather than the count would announce a truncation that never
  // happened.
  const kept = Math.min(rewindTo, session.messages.length);
  const dropped = session.messages.length - kept;
  const next = { ...session, messages: session.messages.slice(0, kept) };
  // Clamping only catches the anchors that are too LARGE, and those are the harmless ones. An
  // older anchor small enough to index the rebuilt array points at a DIFFERENT message: with
  // anchors [1,3,5,7] over nine messages, `/rewind 2` truncates to five, a resume appends five
  // more and records [6,8], and `/rewind 3` then reaches the stale 7 and slices to 7 — leaving an
  // assistant tool-call whose tool result was dropped, which is AI_MissingToolResultsError on the
  // next resume and the exact failure `rewindTo = messages.length - 1` exists to prevent. So a
  // rewind draws the same kind of line compaction does. Recorded only when something was actually
  // dropped: a no-op rewind invalidates nothing, and a barrier for it would throw away history
  // that is still good.
  //
  // Finding 9 (thermo-nuclear structural review, round 6): NOT called here, unlike before — a
  // decision function has no persistence to sequence itself against (this file's own header
  // comment: "no saveSession, no console.log/print*"), and calling it here meant the barrier
  // could land BEFORE the truncated session was ever persisted, an ordering this file had
  // reversed from the original (pre-TUI) `rewindCommand`, which called `saveSession` first and
  // only then `appendBarrier`. Returned as a closure instead, for the caller (cli.ts's
  // rewindCommand) to call AFTER `presenter.sessionUpdated(next)` — restoring that same order, so
  // a barrier is never durably recorded while the truncation it describes still isn't.
  const recordBarrier = (): void => {
    if (dropped > 0) appendBarrier(storeDir, session.id, "rewind");
  };
  return {
    next,
    message: `Session ${next.id}: dropped ${dropped} message(s), ${kept} remain. No file was touched.`,
    recordBarrier,
  };
}
