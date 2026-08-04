import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  commitTree,
  deleteRef,
  diffTree,
  gc,
  initShadow,
  isGitAvailable,
  isIgnored,
  listSessionRefs,
  restoreTree,
  updateRef,
  writeTree,
} from "./shadowGit";
import type { OnBeforeMutation } from "./wrapTools";

// The newest 20 sessions are always intact. Measured: ~4.4 KB of store per snapshot (222 KB over
// 50 snapshots of this 106-file repo), and git's content dedup makes repeated edits to a large
// file nearly free — 50 snapshots each rewriting a 40 KB file cost 55 KB in total. Twenty sessions
// of 50 snapshots is ~4 MB. This is deliberately explicit where opencode's is implicit: their
// snapshots are dangling commits nothing references, so their undo history expires silently at
// seven days and git's automatic gc can take it sooner.
const MAX_RETAINED_SESSIONS = 20;

export type CheckpointRecord =
  | { kind: "tool"; seq: number; toolCallId: string; tool: string; tree: string; commit: string; rewindTo: number; at: string }
  | { kind: "ignored"; toolCallId: string; path: string; at: string }
  | { kind: "compaction-barrier"; at: string }
  | { kind: "pre-undo"; tree: string; commit: string; at: string };

type ToolRecord = Extract<CheckpointRecord, { kind: "tool" }>;

// One store per worktree, under <configDir>/checkpoints. Lowercased first on win32 because NTFS
// paths are case-insensitive and `C:\p` and `c:\p` are the same directory — hashing them
// separately would give one project two undo histories depending on how it was typed.
export function checkpointStoreDir(checkpointsDir: string, worktree: string): string {
  const resolved = resolve(worktree);
  const key = createHash("sha256")
    .update(process.platform === "win32" ? resolved.toLowerCase() : resolved)
    .digest("hex")
    .slice(0, 16);
  return join(checkpointsDir, key);
}

function gitDirOf(storeDir: string): string {
  return join(storeDir, "git");
}

function logPath(storeDir: string, sessionId: string): string {
  return join(storeDir, `${sessionId}.jsonl`);
}

function sessionRef(sessionId: string): string {
  return `refs/seri/sessions/${sessionId}`;
}

function initStore(storeDir: string, worktree: string): void {
  // 0o700 plus an explicit chmod, following authStore.ts: mkdirSync's mode is a no-op when the
  // directory already exists, which is the common case from the second session on. This store
  // holds copies of the user's source, so it is owner-only.
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(storeDir, 0o700);
  // The directory name is a hash, so without this nobody — including the user — can tell which
  // project a store belongs to.
  writeFileSync(join(storeDir, "worktree"), `${resolve(worktree)}\n`);
  initShadow(gitDirOf(storeDir));
}

export function readLog(storeDir: string, sessionId: string): CheckpointRecord[] {
  const path = logPath(storeDir, sessionId);
  if (!existsSync(path)) return [];
  // An unrecognised `kind` written by a future version simply never matches a filter below, so it
  // is skipped rather than fatal. That is the whole of the forward-compatibility story.
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CheckpointRecord);
}

function append(storeDir: string, sessionId: string, record: CheckpointRecord): void {
  appendFileSync(logPath(storeDir, sessionId), `${JSON.stringify(record)}\n`);
}

export function appendBarrier(storeDir: string, sessionId: string): void {
  append(storeDir, sessionId, { kind: "compaction-barrier", at: new Date().toISOString() });
}

// Runs once per session, on the already-cold first checkpoint, and only deletes refs — the
// snapshots themselves stay reachable until gc's default expiry.
export function pruneSessions(storeDir: string): void {
  const gitDir = gitDirOf(storeDir);
  const refs = listSessionRefs(gitDir);
  if (refs.length <= MAX_RETAINED_SESSIONS) return;

  for (const ref of refs.slice(0, refs.length - MAX_RETAINED_SESSIONS)) deleteRef(gitDir, ref);
  gc(gitDir);
}

export function createCheckpointer(opts: {
  storeDir: string;
  worktree: string;
  sessionId: string;
  onWarning: (message: string) => void;
  gitAvailable?: () => boolean;
}): OnBeforeMutation {
  const gitAvailable = opts.gitAvailable ?? isGitAvailable;
  const gitDir = gitDirOf(opts.storeDir);
  const ignoredCache = new Map<string, boolean>();

  let enabled = true;
  let started = false;
  let seq = 0;
  let previousTree: string | undefined;
  let previousCommit: string | undefined;

  function start(): boolean {
    // Degrade, never fail: refusing to edit files because an *undo* feature is unavailable makes
    // seri unusable on a machine without git, which is far worse than losing undo. The warning
    // fires on the first mutating call, BEFORE the tool runs, and names the consequence in words
    // so a user cannot end the session believing they had checkpoints.
    if (!gitAvailable()) {
      opts.onWarning("git was not found on PATH — edits in this session are not checkpointed and cannot be undone");
      return false;
    }
    initStore(opts.storeDir, opts.worktree);
    pruneSessions(opts.storeDir);

    // Resuming a session picks up its existing chain, so --resume keeps appending to one ref
    // rather than orphaning what came before it.
    const existing = readLog(opts.storeDir, opts.sessionId).filter((r): r is ToolRecord => r.kind === "tool");
    seq = existing.length;
    previousTree = existing.at(-1)?.tree;
    previousCommit = existing.at(-1)?.commit;
    return true;
  }

  function warnIfIgnored(tool: string, args: unknown, toolCallId: string): void {
    // Only `write_file` declares a path. For `bash`/`powershell` the path is buried inside an
    // arbitrary shell command and recovering it would mean parsing shell, which this does not
    // pretend to do — so clause (f)'s "name the ignored file" half is knowingly partial. The other
    // half holds for all three tools: /undo reports paths from git's own output, which by
    // construction never contains an ignored file.
    if (tool !== "write_file") return;
    const path = (args as { path?: unknown }).path;
    if (typeof path !== "string") return;

    // Cached per path: check-ignore is 23.5 ms, and a model rewriting one file in a loop would
    // otherwise pay it on every call.
    let ignored = ignoredCache.get(path);
    if (ignored === undefined) {
      ignored = isIgnored(gitDir, opts.worktree, path);
      ignoredCache.set(path, ignored);
    }
    if (!ignored) return;

    opts.onWarning(`${path} is gitignored, so it is not checkpointed — /undo cannot restore it`);
    append(opts.storeDir, opts.sessionId, { kind: "ignored", toolCallId, path, at: new Date().toISOString() });
  }

  return (context) => {
    if (!enabled) return;

    try {
      if (!started) {
        if (!start()) {
          enabled = false;
          return;
        }
        started = true;
      }

      warnIfIgnored(context.tool, context.args, context.toolCallId);

      const tree = writeTree(gitDir, opts.worktree);
      // The one optimisation taken: an unchanged tree means nothing happened since the last
      // checkpoint, so commit-tree and update-ref are skipped — 48.5 ms instead of 107.2 ms,
      // measured. This is the common case, because most `bash` calls read rather than write
      // (`ls`, `bun test`, `git status`). The record is still appended, reusing the previous tree
      // and commit, so the conversation anchor for /rewind is never lost to the optimisation.
      if (tree !== previousTree || previousCommit === undefined) {
        previousCommit = commitTree(gitDir, opts.worktree, tree, previousCommit);
        updateRef(gitDir, sessionRef(opts.sessionId), previousCommit);
        previousTree = tree;
      }

      append(opts.storeDir, opts.sessionId, {
        kind: "tool",
        seq: seq++,
        toolCallId: context.toolCallId,
        tool: context.tool,
        tree,
        commit: previousCommit,
        rewindTo: context.rewindTo,
        at: new Date().toISOString(),
      });
    } catch (err) {
      // The single error policy for the whole feature: one warning, latch off, never block the
      // tool. This also covers index.lock contention between two seri processes in one project, a
      // full disk, and a read-only config dir — a broken store costs one warning, not one per
      // tool call.
      enabled = false;
      opts.onWarning(
        `checkpointing is off for the rest of this session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}

// `/undo` and `/rewind` both step over DISTINCT anchors, so the deduped no-op checkpoints and the
// several tool calls that share one assistant message never produce a step that does nothing.
function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function toolRecords(log: CheckpointRecord[]): ToolRecord[] {
  return log.filter((record): record is ToolRecord => record.kind === "tool");
}

export type UndoResult = {
  seq: number;
  tree: string;
  diff: string;
  restored: string[];
  deleted: string[];
  ignored: string[];
  preUndoCommit: string;
};

export function undoFiles(opts: { storeDir: string; worktree: string; sessionId: string; steps: number }): UndoResult {
  const log = readLog(opts.storeDir, opts.sessionId);
  const records = toolRecords(log);
  // `pre-undo` records are excluded by construction — they describe state an undo replaced, not a
  // point the user asked to be able to return to, and stepping onto one would make `/undo 2` mean
  // "undo the undo".
  const trees = distinct(records.map((record) => record.tree)).reverse();
  const tree = trees[opts.steps - 1];
  if (tree === undefined) {
    throw new Error(`This session has ${trees.length} checkpoint(s) to undo to; asked for ${opts.steps}.`);
  }
  const target = records.find((record) => record.tree === tree);

  const gitDir = gitDirOf(opts.storeDir);
  // Snapshotted before anything is touched, so undo is never the operation that loses work: the
  // commit below holds the current state and is reachable from the session ref.
  const currentTree = writeTree(gitDir, opts.worktree);
  const parent = records.at(-1)?.commit;
  const preUndoCommit = commitTree(gitDir, opts.worktree, currentTree, parent);
  updateRef(gitDir, sessionRef(opts.sessionId), preUndoCommit);
  append(opts.storeDir, opts.sessionId, {
    kind: "pre-undo",
    tree: currentTree,
    commit: preUndoCommit,
    at: new Date().toISOString(),
  });

  const diff = diffTree(gitDir, opts.worktree, tree);
  const { restored, deleted } = restoreTree(gitDir, opts.worktree, tree);

  return {
    seq: target?.seq ?? 0,
    tree,
    diff,
    restored,
    deleted,
    // Reported so the user is told what undo did NOT cover, rather than left to infer it from a
    // list that silently omits them.
    ignored: distinct(log.filter((record) => record.kind === "ignored").map((record) => record.path)),
    preUndoCommit,
  };
}

// Reads the log and nothing else — it has no path to shadowGit, so "rewind leaves the filesystem
// byte-identical" is structural rather than something the code has to remember to do.
export function rewindConversation(opts: { storeDir: string; sessionId: string; steps: number }): { rewindTo: number } {
  const log = readLog(opts.storeDir, opts.sessionId);

  // loop.ts:65 splices the whole message array on compaction, so a rewindTo recorded before it
  // indexes into an array that no longer exists. Refusing is the honest answer; silently slicing
  // a compacted array would hand back garbage.
  let barrier = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]?.kind === "compaction-barrier") {
      barrier = i;
      break;
    }
  }

  const anchors = distinct(toolRecords(log.slice(barrier + 1)).map((record) => record.rewindTo)).reverse();
  const rewindTo = anchors[opts.steps - 1];
  if (rewindTo === undefined) {
    throw new Error(
      barrier === -1
        ? `This session has ${anchors.length} point(s) to rewind to; asked for ${opts.steps}.`
        : `This session only has ${anchors.length} point(s) to rewind to since the last compaction; anything older than that was summarized away by compaction and cannot be restored.`,
    );
  }
  return { rewindTo };
}
