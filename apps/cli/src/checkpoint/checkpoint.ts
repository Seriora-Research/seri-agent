import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  applyRestore,
  commitTree,
  deleteRef,
  diffTree,
  gc,
  initShadow,
  isGitAvailable,
  isIgnored,
  listSessionRefs,
  planRestore,
  resolveRef,
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
type AnchoredRecord = Extract<CheckpointRecord, { tree: string; commit: string }>;

// What a snapshot can do for a path a tool declared: capture it, skip it because the project's own
// .gitignore excludes it, or not see it at all because it is not in the tree being snapshotted.
type PathScope = "checkpointed" | "ignored" | "outside";

// Every record that carries a snapshot — tool checkpoints and the states an undo replaced. Both
// sit in the commit chain; only the first kind is somewhere `/undo` may step to.
function anchored(log: CheckpointRecord[]): AnchoredRecord[] {
  return log.filter((record): record is AnchoredRecord => record.kind === "tool" || record.kind === "pre-undo");
}

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
  // No log means this session never took a checkpoint — git absent, or the error latch tripped —
  // so there is nothing for a barrier to protect and nowhere to write it. The predicate lives here
  // because it is about this session's log; asking the caller to test for the store directory
  // instead would answer a different question, since the store is keyed per worktree and is
  // already there whenever any earlier session in the same directory checkpointed.
  if (!existsSync(logPath(storeDir, sessionId))) return;
  append(storeDir, sessionId, { kind: "compaction-barrier", at: new Date().toISOString() });
}

// Runs once per session, on the already-cold first checkpoint, and only deletes refs — the
// snapshots themselves stay reachable until gc's default expiry.
//
// `keep` is the ref of the session doing the pruning, and it is excluded from the candidates
// rather than merely counted among them. Pruning runs BEFORE the session's own tip is read back
// out of the ref, and the ordering is oldest-first, so resuming a session that has fallen outside
// the newest 20 deleted its own ref and then gc'd: `previousCommit` came back undefined, the
// session silently started a fresh root chain, and its earlier snapshots went unreachable while
// the log went on listing them. Excluding it means at most 20 other sessions plus this one.
export function pruneSessions(storeDir: string, keep?: string): void {
  const gitDir = gitDirOf(storeDir);
  const refs = listSessionRefs(gitDir).filter((ref) => ref !== keep);
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
  const scopeCache = new Map<string, PathScope>();

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
    // Retention is housekeeping, not part of taking a checkpoint. `gc` exits non-zero when another
    // process holds gc.pid or the packed-refs lock — exactly the two-seri-processes-in-one-project
    // case — and letting that reach the latch below would turn a failed tidy-up into no undo for
    // the rest of the session. Nothing is lost by skipping it: no snapshot goes away, the store is
    // just larger than intended, so there is nothing to tell the user either.
    try {
      pruneSessions(opts.storeDir, sessionRef(opts.sessionId));
    } catch {}

    // Resuming a session picks up its existing chain, so --resume keeps appending to one ref
    // rather than orphaning what came before it. The parent comes from the ref, not from the log:
    // the tip may be a pre-undo commit, which is not a tool record, and branching beside it would
    // strand the recovery commit /undo already printed to the user.
    const log = readLog(opts.storeDir, opts.sessionId);
    seq = log.filter((record) => record.kind === "tool").length;
    previousTree = anchored(log).at(-1)?.tree;
    previousCommit = resolveRef(gitDir, sessionRef(opts.sessionId));
    return true;
  }

  // Whether a path a tool declared is inside the tree this session snapshots, and if so whether the
  // project's own .gitignore excludes it.
  //
  // The outside case is decided here by path arithmetic rather than by asking git, and that is the
  // point: `git check-ignore` exits 128 for any absolute path outside the worktree and for any
  // `../` path (measured, git 2.54.0.windows.1: `fatal: '<p>' is outside repository at '<w>'`),
  // isIgnored throws on any status outside {0,1}, and that throw reached the error latch below —
  // so a model writing one scratch file to a temp dir on its first tool call ended the session with
  // ZERO records in the log and every later edit unprotected. Reading exit 128 as "outside" would
  // fix that case and break another, because git also exits 128 with "not a git repository" for a
  // store that is genuinely broken, which must still latch off.
  function scopeOf(path: string): PathScope {
    const inside = relative(opts.worktree, resolve(opts.worktree, path));
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return "outside";
    return isIgnored(gitDir, opts.worktree, path) ? "ignored" : "checkpointed";
  }

  function warnIfNotCheckpointed(tool: string, args: unknown, toolCallId: string): void {
    // Only `write_file` declares a path. For `bash`/`powershell` the path is buried inside an
    // arbitrary shell command and recovering it would mean parsing shell, which this does not
    // pretend to do — so naming the ignored file is knowingly partial, covering one of the three
    // tools. What does hold for all three: /undo reports paths from git's own output, which by
    // construction never contains an ignored file, so it can never claim to have restored one.
    if (tool !== "write_file") return;
    const path = (args as { path?: unknown }).path;
    if (typeof path !== "string") return;

    // Cached per path: check-ignore is 23.5 ms, and a model rewriting one file in a loop would
    // otherwise pay it on every call. It also makes each warning fire once per path rather than
    // once per write.
    let scope = scopeCache.get(path);
    if (scope === undefined) {
      scope = scopeOf(path);
      scopeCache.set(path, scope);
    }
    if (scope === "checkpointed") return;

    if (scope === "outside") {
      // No `ignored` record for this one: that record feeds /undo's "not restored (gitignored)"
      // line, and a path outside the worktree is not gitignored — filing it there would put a
      // wrong reason next to a right file.
      opts.onWarning(`${path} is outside ${opts.worktree}, so it is not checkpointed — /undo cannot restore it`);
      return;
    }

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

      warnIfNotCheckpointed(context.tool, context.args, context.toolCallId);

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

function toolRecords(log: CheckpointRecord[]): ToolRecord[] {
  return log.filter((record): record is ToolRecord => record.kind === "tool");
}

// The steps `/undo n` and `/rewind n` count: newest first, one per distinct anchor, so the deduped
// no-op checkpoints and the several tool calls sharing one assistant message never produce a step
// that does nothing.
//
// The reversal happens BEFORE the dedupe, and that ordering is the whole point. A Set keeps each
// value at its FIRST insertion position, so deduping and then reversing ranks a repeated anchor at
// its OLDEST occurrence. Repeats are not exotic here — an undo restores an earlier tree, and the
// next checkpoint records that same tree again — and the effect was that `/undo 1` could move the
// worktree FORWARD onto a state the user had just reverted, while printing that it had undone.
function newestDistinct<T, K>(records: T[], key: (record: T) => K): T[] {
  const byKey = new Map<K, T>();
  for (const record of [...records].reverse()) if (!byKey.has(key(record))) byKey.set(key(record), record);
  return [...byKey.values()];
}

// What `/undo` is about to do, handed to the caller before any of it is done — the diff and the
// deletion list are the reviewable part, and a user learning which of their files were removed
// only afterwards is being told, not asked.
export type UndoPlan = {
  seq: number;
  tree: string;
  diff: string;
  restored: string[];
  deleted: string[];
  ignored: string[];
};

export type UndoResult = UndoPlan & {
  preUndoCommit: string;
  // Plain git, not a seri subcommand, and safe to paste: the store's own config carries the crlf
  // settings (initShadow), and the paths are quoted so a project directory with a space in it
  // still works.
  recoverCommand: string;
};

export function undoFiles(opts: {
  storeDir: string;
  worktree: string;
  sessionId: string;
  steps: number;
  onPlan: (plan: UndoPlan) => void;
}): UndoResult {
  const log = readLog(opts.storeDir, opts.sessionId);
  // `pre-undo` records are excluded here — they describe state an undo replaced, not a point the
  // user asked to be able to return to, and stepping onto one would make `/undo 2` mean "undo the
  // undo". They are still part of the commit chain; see the parent below.
  const targets = newestDistinct(toolRecords(log), (record) => record.tree);
  const target = targets[opts.steps - 1];
  if (target === undefined) {
    throw new Error(`This session has ${targets.length} checkpoint(s) to undo to; asked for ${opts.steps}.`);
  }

  const gitDir = gitDirOf(opts.storeDir);
  // Taken before anything is touched, so undo is never the operation that loses work. The parent
  // is the ref itself rather than the last tool record: a second undo would otherwise branch off
  // beside the first pre-undo commit instead of through it, leaving a hash this function already
  // printed to the user unreachable and on gc's clock.
  const currentTree = writeTree(gitDir, opts.worktree);
  const preUndoCommit = commitTree(gitDir, opts.worktree, currentTree, resolveRef(gitDir, sessionRef(opts.sessionId)));
  updateRef(gitDir, sessionRef(opts.sessionId), preUndoCommit);
  append(opts.storeDir, opts.sessionId, {
    kind: "pre-undo",
    tree: currentTree,
    commit: preUndoCommit,
    at: new Date().toISOString(),
  });

  const plan: UndoPlan = {
    seq: target.seq,
    tree: target.tree,
    diff: diffTree(gitDir, opts.worktree, target.tree),
    ...planRestore(gitDir, opts.worktree, target.tree),
    // Reported so the user is told what undo did NOT cover, rather than left to infer it from a
    // list that silently omits them.
    ignored: newestDistinct(
      log.filter((record) => record.kind === "ignored"),
      (record) => record.path,
    ).map((record) => record.path),
  };
  opts.onPlan(plan);
  applyRestore(gitDir, opts.worktree, plan.deleted);

  return {
    ...plan,
    preUndoCommit,
    recoverCommand:
      `git --git-dir="${gitDir}" --work-tree="${opts.worktree}" read-tree ${preUndoCommit} && ` +
      `git --git-dir="${gitDir}" --work-tree="${opts.worktree}" checkout-index -a -f`,
  };
}

// Reads the log and nothing else — it has no path to shadowGit, so "rewind leaves the filesystem
// byte-identical" is structural rather than something the code has to remember to do.
export function rewindConversation(opts: { storeDir: string; sessionId: string; steps: number }): { rewindTo: number } {
  const log = readLog(opts.storeDir, opts.sessionId);

  // Compaction splices the whole message array, so a rewindTo recorded before it indexes into an
  // array that no longer exists. Refusing is the honest answer; silently slicing a compacted array
  // would hand back garbage.
  // `findLastIndex` would say this in one word, but it is ES2023 and this package compiles against
  // the ES2022 lib.
  const barrier = log.reduce((last, record, index) => (record.kind === "compaction-barrier" ? index : last), -1);

  // Anchors are not monotonic across a session: a `/rewind` truncates the array and the messages
  // that follow reuse indices already seen, so newestDistinct's ordering matters here for the same
  // reason it does above.
  const anchors = newestDistinct(toolRecords(log.slice(barrier + 1)), (record) => record.rewindTo);
  const rewindTo = anchors[opts.steps - 1]?.rewindTo;
  if (rewindTo === undefined) {
    throw new Error(
      barrier === -1
        ? `This session has ${anchors.length} point(s) to rewind to; asked for ${opts.steps}.`
        : `This session only has ${anchors.length} point(s) to rewind to since the last compaction; anything older than that was summarized away by compaction and cannot be restored.`,
    );
  }
  return { rewindTo };
}
