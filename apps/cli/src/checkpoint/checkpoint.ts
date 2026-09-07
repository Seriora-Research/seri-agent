import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureOwnerOnlyDir } from "../atomicWriteFile";
import { foldsCase } from "../caseFold";
import { clearEolCache } from "../tools/eolCache";
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
  mirrorLocalExcludes,
  planRestore,
  resolveRef,
  summarizeIndex,
  treeExists,
  updateRef,
  writeTree,
} from "./shadowGit";
import type { MutationContext, OnAfterMutation, OnBeforeMutation } from "./wrapTools";
import { filterSafeToDelete, recordWrite } from "./writeLedger";

const MAX_RETAINED_SESSIONS = 20;

const LARGE_WORKTREE_FILES = 5_000;

export type CheckpointRecord =
  | {
      kind: "tool";
      seq: number;
      toolCallId: string;
      tool: string;
      tree: string;
      commit: string;
      rewindTo: number;
      at: string;
    }
  | { kind: "ignored"; toolCallId: string; path: string; at: string }
  | { kind: "compaction-barrier"; at: string }
  | { kind: "rewind-barrier"; at: string }
  | { kind: "pre-undo"; tree: string; commit: string; at: string };

type BarrierCause = "compaction" | "rewind";

type ToolRecord = Extract<CheckpointRecord, { kind: "tool" }>;
type AnchoredRecord = Extract<CheckpointRecord, { tree: string; commit: string }>;

type PathScope = "checkpointed" | "ignored" | "outside";

function anchored(log: CheckpointRecord[]): AnchoredRecord[] {
  return log.filter(
    (record): record is AnchoredRecord => record.kind === "tool" || record.kind === "pre-undo",
  );
}

const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /\brm\b/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\binstall\b/,
  // \b does not fire between word characters, so /\binstall\b/ never matches "uninstall".
  /\buninstall\b/,
  // Without the s flag, . cannot cross a newline, so a backslash-continued sed -i never matches.
  /\bsed\b.*-i\b/s,
  /\btruncate\b/,
  /\bdd\b/,
  /\bshred\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+restore\b/,
  /\bgit\s+stash\b/,
  /\bgit\s+apply\b/,
  /\btee\b/,
  /\bpatch\b/,
  /\bRemove-Item\b/i,
  /\bdel\b/i,
  /\berase\b/i,
  /\bri\b/i,
  /\bMove-Item\b/i,
  /\bren\b/i,
  /\bRename-Item\b/i,
  /\bCopy-Item\b.*-Force\b/is,
  /\bSet-Content\b/i,
  /\bClear-Content\b/i,
  /\bOut-File\b/i,
  />{1,2}/,
];

function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function commandOf(args: unknown): string | undefined {
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

// NTFS and APFS fold case by default, so win32 and darwin hash a lowercased worktree path into one store key.
export function checkpointStoreDir(checkpointsDir: string, worktree: string): string {
  const resolved = resolve(worktree);
  const key = createHash("sha256")
    .update(foldsCase() ? resolved.toLowerCase() : resolved)
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

const SESSION_REF_PREFIX = "refs/seri/sessions/";

function sessionRef(sessionId: string): string {
  return `${SESSION_REF_PREFIX}${sessionId}`;
}

function initStore(storeDir: string, worktree: string): void {
  ensureOwnerOnlyDir(storeDir);
  writeFileSync(join(storeDir, "worktree"), `${resolve(worktree)}\n`);
  initShadow(gitDirOf(storeDir));
  mirrorLocalExcludes(gitDirOf(storeDir), worktree);
}

export function readLog(storeDir: string, sessionId: string): CheckpointRecord[] {
  const path = logPath(storeDir, sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CheckpointRecord];
      } catch {
        return [];
      }
    });
}

function append(storeDir: string, sessionId: string, record: CheckpointRecord): void {
  appendFileSync(logPath(storeDir, sessionId), `${JSON.stringify(record)}\n`);
}

export function appendBarrier(storeDir: string, sessionId: string, cause: BarrierCause): void {
  if (!existsSync(logPath(storeDir, sessionId))) return;
  const kind = cause === "compaction" ? "compaction-barrier" : "rewind-barrier";
  append(storeDir, sessionId, { kind, at: new Date().toISOString() });
}

export function pruneSessions(storeDir: string, keep?: string): void {
  const gitDir = gitDirOf(storeDir);
  const refs = listSessionRefs(gitDir).filter((ref) => ref !== keep);
  if (refs.length <= MAX_RETAINED_SESSIONS) return;

  for (const ref of refs.slice(0, refs.length - MAX_RETAINED_SESSIONS)) {
    deleteRef(gitDir, ref);
    rmSync(logPath(storeDir, ref.slice(SESSION_REF_PREFIX.length)), { force: true });
  }
  gc(gitDir);
}

export type Checkpointer = OnBeforeMutation & {
  onAfterMutation: OnAfterMutation;
  invalidate: () => void;
};

export function createCheckpointer(opts: {
  storeDir: string;
  worktree: string;
  sessionId: string;
  onWarning: (message: string) => void;
  gitAvailable?: () => boolean;
  // Session cwd, not process.cwd(); write_file resolves relative paths against this directory.
  cwd?: string;
}): Checkpointer {
  const sessionCwd = opts.cwd ?? process.cwd();
  const gitAvailable = opts.gitAvailable ?? isGitAvailable;
  const gitDir = gitDirOf(opts.storeDir);
  const scopeCache = new Map<string, PathScope>();

  let enabled = true;
  let started = false;
  let scoped = false;
  let seq = 0;
  let previousTree: string | undefined;
  let previousCommit: string | undefined;
  let snapshottedThisProcess = false;
  const pendingWritePaths = new Set<string>();
  let needsFullAdd = false;

  function start(): boolean {
    if (!gitAvailable()) {
      opts.onWarning(
        "git was not found on PATH — edits in this session are not checkpointed and cannot be undone",
      );
      return false;
    }
    initStore(opts.storeDir, opts.worktree);
    try {
      pruneSessions(opts.storeDir, sessionRef(opts.sessionId));
    } catch {}

    const log = readLog(opts.storeDir, opts.sessionId);
    seq = log.filter((record) => record.kind === "tool").length;
    previousTree = anchored(log).at(-1)?.tree;
    previousCommit = resolveRef(gitDir, sessionRef(opts.sessionId));
    return true;
  }

  // git check-ignore exits 128 for a path outside the worktree, which isIgnored would throw on.
  function scopeOf(path: string): PathScope {
    const absolute = isAbsolute(path) ? path : resolve(sessionCwd, path);
    const inside = relative(opts.worktree, absolute);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return "outside";
    return isIgnored(gitDir, opts.worktree, absolute) ? "ignored" : "checkpointed";
  }

  function relativeInside(absolute: string): string | undefined {
    const inside = relative(opts.worktree, absolute);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
    return inside.replaceAll("\\", "/");
  }

  function writePathRel(declared: string): string | undefined {
    let scope = scopeCache.get(declared);
    if (scope === undefined) {
      scope = scopeOf(declared);
      scopeCache.set(declared, scope);
    }
    if (scope !== "checkpointed") return undefined;
    const absolute = isAbsolute(declared) ? declared : resolve(sessionCwd, declared);
    return relativeInside(absolute);
  }

  function warnIfNotCheckpointed(tool: string, args: unknown, toolCallId: string): void {
    if (tool !== "write_file") return;
    const path = (args as { path?: unknown }).path;
    if (typeof path !== "string") return;

    let scope = scopeCache.get(path);
    if (scope === undefined) {
      scope = scopeOf(path);
      scopeCache.set(path, scope);
    }
    if (scope === "checkpointed") return;

    if (scope === "outside") {
      opts.onWarning(
        `${path} is outside ${opts.worktree}, so it is not checkpointed — /undo cannot restore it`,
      );
      return;
    }

    opts.onWarning(`${path} is gitignored, so it is not checkpointed — /undo cannot restore it`);
    append(opts.storeDir, opts.sessionId, {
      kind: "ignored",
      toolCallId,
      path,
      at: new Date().toISOString(),
    });
  }

  function warnAboutScope(): void {
    const { files, nested } = summarizeIndex(gitDir, opts.worktree);
    const messages: string[] = [];

    if (nested.length > 0) {
      messages.push(
        `${nested.join(", ")} ${nested.length === 1 ? "is a nested git repository" : "are nested git repositories"} — changes inside are not checkpointed and /undo will not revert them`,
      );
    }

    if (files > LARGE_WORKTREE_FILES) {
      messages.push(
        `checkpointing ${files} files under ${opts.worktree} on the first snapshot and on shell mutations — later write_file restages only paths this session wrote; a .gitignore would narrow it`,
      );
    }

    if (messages.length > 0) opts.onWarning(messages.join("; "));
  }

  const handler: OnBeforeMutation = (context) => {
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

      const command = commandOf(context.args);
      const mustSnapshot =
        context.tool === "write_file" ||
        !snapshottedThisProcess ||
        command === undefined ||
        isDestructiveCommand(command);

      const declared =
        context.tool === "write_file" ? (context.args as { path?: unknown }).path : undefined;
      const writeRel = typeof declared === "string" ? writePathRel(declared) : undefined;
      const pathScoped =
        mustSnapshot && context.tool === "write_file" && snapshottedThisProcess && !needsFullAdd;
      const restage = pathScoped
        ? [
            ...new Set([...pendingWritePaths, ...(writeRel !== undefined ? [writeRel] : [])]),
          ].filter((rel) => existsSync(join(opts.worktree, rel)))
        : undefined;
      const tree = mustSnapshot
        ? writeTree(gitDir, opts.worktree, restage)
        : (previousTree as string);
      if (mustSnapshot) {
        snapshottedThisProcess = true;
        if (!pathScoped) pendingWritePaths.clear();
        needsFullAdd = context.tool !== "write_file";
        if (writeRel !== undefined) pendingWritePaths.add(writeRel);
        if (!scoped) {
          scoped = true;
          warnAboutScope();
        }
      }
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
      enabled = false;
      opts.onWarning(
        `checkpointing is off for the rest of this session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const onAfterMutation: OnAfterMutation = (context: MutationContext) => {
    if (!enabled || context.tool !== "write_file") return;
    const path = (context.args as { path?: unknown }).path;
    if (typeof path !== "string") return;
    try {
      const absolute = isAbsolute(path) ? path : resolve(sessionCwd, path);
      recordWrite(opts.storeDir, absolute, readFileSync(absolute, "utf8"));
    } catch {}
  };

  const invalidate = (): void => {
    previousTree = undefined;
    snapshottedThisProcess = false;
    pendingWritePaths.clear();
    needsFullAdd = false;
    previousCommit = resolveRef(gitDir, sessionRef(opts.sessionId));
  };

  return Object.assign(handler, { onAfterMutation, invalidate });
}

function toolRecords(log: CheckpointRecord[]): ToolRecord[] {
  return log.filter((record): record is ToolRecord => record.kind === "tool");
}

function newestDistinct<T, K>(records: T[], key: (record: T) => K): T[] {
  const byKey = new Map<K, T>();
  for (const record of [...records].reverse())
    if (!byKey.has(key(record))) byKey.set(key(record), record);
  return [...byKey.values()];
}

export type RestorePlan = {
  tree: string;
  diff: string;
  restored: string[];
  deleted: string[];
  ignored: string[];
  // Paths the tree diff considered extraneous that the write ledger could not vouch for.
  preserved: string[];
};

export type RestoreResult = RestorePlan & {
  preUndoCommit: string;
  recoverCommand: string;
};

type RestoreOpts = {
  storeDir: string;
  worktree: string;
  sessionId: string;
  onPlan: (plan: RestorePlan) => void;
};

function ignoredSince(log: CheckpointRecord[], index: number): string[] {
  return newestDistinct(
    log.slice(index).filter((record) => record.kind === "ignored"),
    (record) => record.path,
  ).map((record) => record.path);
}

function partitionByLedger(
  storeDir: string,
  worktree: string,
  candidates: string[],
): { safe: string[]; unsafe: string[] } {
  const safeSet = new Set(filterSafeToDelete(storeDir, worktree, candidates));
  return {
    safe: candidates.filter((path) => safeSet.has(path)),
    unsafe: candidates.filter((path) => !safeSet.has(path)),
  };
}

function restoreTo(opts: RestoreOpts, treeish: string, ignored: string[]): RestoreResult {
  const gitDir = gitDirOf(opts.storeDir);
  if (!treeExists(gitDir, treeish)) {
    throw new Error(`${treeish} is not a checkpoint in this session's store.`);
  }
  const currentTree = writeTree(gitDir, opts.worktree);
  const preUndoCommit = commitTree(
    gitDir,
    opts.worktree,
    currentTree,
    resolveRef(gitDir, sessionRef(opts.sessionId)),
  );
  updateRef(gitDir, sessionRef(opts.sessionId), preUndoCommit);
  append(opts.storeDir, opts.sessionId, {
    kind: "pre-undo",
    tree: currentTree,
    commit: preUndoCommit,
    at: new Date().toISOString(),
  });

  const candidates = planRestore(gitDir, opts.worktree, treeish);
  const { safe: deleted, unsafe: preserved } = partitionByLedger(
    opts.storeDir,
    opts.worktree,
    candidates.deleted,
  );

  const plan: RestorePlan = {
    tree: treeish,
    diff: diffTree(gitDir, opts.worktree, treeish),
    restored: candidates.restored,
    deleted,
    ignored,
    preserved,
  };
  opts.onPlan(plan);
  const { safe: finalDeleted, unsafe: newlyUnsafe } = partitionByLedger(
    opts.storeDir,
    opts.worktree,
    plan.deleted,
  );
  const finalPreserved = [...plan.preserved, ...newlyUnsafe];
  try {
    applyRestore(gitDir, opts.worktree, finalDeleted);
  } finally {
    clearEolCache();
  }

  return {
    ...plan,
    deleted: finalDeleted,
    preserved: finalPreserved,
    preUndoCommit,
    recoverCommand: `/restore ${preUndoCommit}`,
  };
}

export function undoFiles(opts: RestoreOpts & { steps: number }): RestoreResult {
  const log = readLog(opts.storeDir, opts.sessionId);
  const targets = newestDistinct(toolRecords(log), (record) => record.tree);
  const target = targets[opts.steps - 1];
  if (target === undefined) {
    throw new Error(
      `This session has ${targets.length} checkpoint(s) to undo to; asked for ${opts.steps}.`,
    );
  }

  const from = log.findIndex(
    (record) => "toolCallId" in record && record.toolCallId === target.toolCallId,
  );
  return restoreTo(opts, target.tree, ignoredSince(log, from));
}

export function restoreCommit(opts: RestoreOpts & { commit: string }): RestoreResult {
  return restoreTo(opts, opts.commit, ignoredSince(readLog(opts.storeDir, opts.sessionId), 0));
}

export function rewindConversation(opts: { storeDir: string; sessionId: string; steps: number }): {
  rewindTo: number;
} {
  const log = readLog(opts.storeDir, opts.sessionId);

  let barrier = -1;
  let barrierCause: BarrierCause | undefined;
  for (const [index, record] of log.entries()) {
    if (record.kind === "compaction-barrier") [barrier, barrierCause] = [index, "compaction"];
    if (record.kind === "rewind-barrier") [barrier, barrierCause] = [index, "rewind"];
  }

  const anchors = newestDistinct(toolRecords(log.slice(barrier + 1)), (record) => record.rewindTo);
  const rewindTo = anchors[opts.steps - 1]?.rewindTo;
  if (rewindTo === undefined) {
    throw new Error(
      barrierCause === undefined
        ? `This session has ${anchors.length} point(s) to rewind to; asked for ${opts.steps}.`
        : barrierCause === "compaction"
          ? `This session only has ${anchors.length} point(s) to rewind to since the last compaction; anything older than that was summarized away by compaction and cannot be restored.`
          : `This session only has ${anchors.length} point(s) to rewind to since the last rewind; anything older than that points into messages that rewind removed.`,
    );
  }
  return { rewindTo };
}
