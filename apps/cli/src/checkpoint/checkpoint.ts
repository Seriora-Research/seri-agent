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

// The newest 20 sessions are always intact. Measured: ~4.4 KB of store per snapshot (222 KB over
// 50 snapshots of this 106-file repo), and git's content dedup makes repeated edits to a large
// file nearly free — 50 snapshots each rewriting a 40 KB file cost 55 KB in total. Twenty sessions
// of 50 snapshots is ~4 MB. This is deliberately explicit where opencode's is implicit: their
// snapshots are dangling commits nothing references, so their undo history expires silently at
// seven days and git's automatic gc can take it sooner.
const MAX_RETAINED_SESSIONS = 20;

// Far above any hand-written project (this repo stages 106) and far below an unignored
// node_modules (29,808 here), so it fires on the shape that is a surprise and not on the one that
// is a normal repository.
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

// The two events that make every rewind anchor recorded before them meaningless, and so the two
// things `/rewind` may not step across. Compaction splices the message array; a rewind truncates it
// and lets the messages that follow reuse the indices that were freed.
type BarrierCause = "compaction" | "rewind";

type ToolRecord = Extract<CheckpointRecord, { kind: "tool" }>;
type AnchoredRecord = Extract<CheckpointRecord, { tree: string; commit: string }>;

// What a snapshot can do for a path a tool declared: capture it, skip it because the project's own
// .gitignore excludes it, or not see it at all because it is not in the tree being snapshotted.
type PathScope = "checkpointed" | "ignored" | "outside";

// Every record that carries a snapshot — tool checkpoints and the states an undo replaced. Both
// sit in the commit chain; only the first kind is somewhere `/undo` may step to.
function anchored(log: CheckpointRecord[]): AnchoredRecord[] {
  return log.filter(
    (record): record is AnchoredRecord => record.kind === "tool" || record.kind === "pre-undo",
  );
}

// Curated verbs, not shell parsing — the same tradeoff Hermes (github.com/NousResearch/hermes-agent)
// ships with for its own destructive-command gate. A real parser would need two grammars (bash and
// PowerShell), their aliases, and their quoting rules; a word-boundary regex scan needs none of
// that and costs nothing extra per call, so `bash("ls")`/`bash("git status")` — the common case,
// most `bash` calls read rather than write — can skip writeTree's two spawns entirely instead of
// paying them to discover nothing changed. Word-boundary (`\b`), not substring: a bare `mv` must
// not fire on a filename that happens to contain those letters, e.g. `mv2.txt`.
//
// Accepted residual risk, same one Hermes accepts: an unrecognised or obfuscated destructive
// command (a dynamically-built string, a shell alias, `find -delete`, a script that shells out to
// `rm` two levels down) skips writeTree, so anything it creates was never captured in any tree and
// never recorded in the write ledger either. /undo's removal pass only deletes ledger-verified
// paths, so a file from an unrecognised command is not in the ledger and is preserved rather than
// deleted — but that means /undo silently leaves it behind instead of restoring the pre-command
// state for it. A false positive here only costs one extra git spawn; a false negative costs undo
// coverage for that one call — so the list leans broad rather than narrow.
const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  // bash
  /\brm\b/,
  /\brmdir\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\binstall\b/,
  // \b does not fire between "n" and "i" (both word characters, no boundary there), so
  // /\binstall\b/ alone never matches "uninstall" — verified directly: that regex against
  // "npm uninstall lodash" returns false, silently letting a real dependency removal skip the
  // snapshot. A separate pattern, not folding "un" into the existing one, keeps the un-prefixed
  // "install" match intact rather than making both conditional on the same alternation.
  /\buninstall\b/,
  // `s` flag: without it, `.` cannot cross a `\n`, so a command split across lines by a backslash
  // continuation (`sed \` + newline + `  -i ...`) never matches — a real, plausible shape for a
  // multi-line command string, not just a single physical line.
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
  // PowerShell
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
  // output redirection, both shells — coarse on purpose (Hermes takes the same approach): it does
  // not distinguish `>` from a `->` or a comparison inside a quoted string, so it also fires on a
  // handful of read-only commands (e.g. `echo "a > b"`), which only costs the spawn it exists to
  // save on the destructive case.
  />{1,2}/,
];

function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

// bash/powershell are the only tools whose mutation is buried inside an arbitrary command string —
// see warnIfNotCheckpointed's identical note. Non-string/absent `command` (a malformed tool call)
// is treated as destructive: whatever it is, this function cannot say it is safe to skip.
function commandOf(args: unknown): string | undefined {
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

// One store per project, under <configDir>/checkpoints. `worktree` is the project root from
// `projectRoot`, not the directory seri was started in, so every session in one repository shares
// a store however deep in it the user was standing.
//
// Lowercased first on win32 AND darwin, because NTFS and APFS are both case-insensitive by
// default: `/Users/x/Proj` and `/Users/x/proj` are one directory, and hashing them separately
// gives one project two undo histories depending on how the path was typed. It does not take a
// typo to get there — shell autocomplete, a symlink, or a script assembling the path differently
// all do.
//
// The residual, stated rather than hidden: APFS *can* be formatted case-sensitive, and NTFS has
// supported per-directory case sensitivity since Windows 10. On such a volume two projects whose
// paths differ only in case are genuinely different directories, and this folds them into one
// store — checkpoints from one restoring over the other, which is a worse failure than a split
// history. It is accepted on both platforms for the same two reasons: that case needs a
// case-sensitive volume *and* two projects differing only in case, where the case this prevents
// needs only a differently-capitalised invocation; and win32 already made exactly this trade, so
// folding darwin is consistency with a decision this code took rather than a new one.
//
// A runtime probe — write a temp file, see whether the other-case name resolves — would be correct
// on both APFS variants. It was weighed and rejected as disproportionate: filesystem I/O and a
// cache on every store lookup, to separate two projects that differ only in capitalisation.
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
  // This store holds copies of the user's source, so it is owner-only.
  ensureOwnerOnlyDir(storeDir);
  // The directory name is a hash, so without this nobody — including the user — can tell which
  // project a store belongs to.
  writeFileSync(join(storeDir, "worktree"), `${resolve(worktree)}\n`);
  initShadow(gitDirOf(storeDir));
  mirrorLocalExcludes(gitDirOf(storeDir), worktree);
}

export function readLog(storeDir: string, sessionId: string): CheckpointRecord[] {
  const path = logPath(storeDir, sessionId);
  if (!existsSync(path)) return [];
  // Two ways a line can be unusable, both skipped rather than fatal — which is the whole of the
  // forward-compatibility story, and now actually true of both. An unrecognised `kind` written by
  // a future version never matches a filter below. An unparseable line is dropped here: the log is
  // appended to with no fsync, so a kill or an ENOSPC mid-appendFileSync leaves a truncated final
  // line, and a JSON.parse throw for it latched checkpointing off for the rest of the session with
  // a raw SyntaxError as the warning, and left /undo, /rewind and /restore unusable for that
  // session permanently. One bad tail line is not worth the whole history.
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
  // No log means this session never took a checkpoint — git absent, or the error latch tripped —
  // so there is nothing for a barrier to protect and nowhere to write it. The predicate lives here
  // because it is about this session's log; asking the caller to test for the store directory
  // instead would answer a different question, since the store is keyed per project and is
  // already there whenever any earlier session in the same project checkpointed.
  if (!existsSync(logPath(storeDir, sessionId))) return;
  const kind = cause === "compaction" ? "compaction-barrier" : "rewind-barrier";
  append(storeDir, sessionId, { kind, at: new Date().toISOString() });
}

// Runs once per session, on the already-cold first checkpoint. The log goes with the ref, because
// a log outliving its snapshots is worse than no log: /undo on a pruned session read a full
// history, computed targets from it, and then failed at `treeExists` with "not a checkpoint in
// this session's store" while the file it had just read listed dozens of them.
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

  for (const ref of refs.slice(0, refs.length - MAX_RETAINED_SESSIONS)) {
    deleteRef(gitDir, ref);
    rmSync(logPath(storeDir, ref.slice(SESSION_REF_PREFIX.length)), { force: true });
  }
  gc(gitDir);
}

// The value createCheckpointer returns: still directly callable as an OnBeforeMutation (every
// existing caller — withCheckpoints, dispatch.ts's subagent runtime — keeps calling it exactly
// that way), plus two capabilities only the caller that actually holds the live instance needs.
// `onAfterMutation` is the write-ledger half of the destructive-restore fix (writeLedger.ts's own
// header comment): wired into withCheckpoints as the third argument, alongside the same handler
// as the first. `invalidate` is restoreTo's own escape hatch for a live checkpointer's stale
// state — see its call site's comment in restoreTo, below.
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
}): Checkpointer {
  const gitAvailable = opts.gitAvailable ?? isGitAvailable;
  const gitDir = gitDirOf(opts.storeDir);
  const scopeCache = new Map<string, PathScope>();

  let enabled = true;
  let started = false;
  let scoped = false;
  let seq = 0;
  let previousTree: string | undefined;
  let previousCommit: string | undefined;
  // Tracks whether THIS process has taken a real snapshot yet, independent of `previousTree`:
  // `start()` seeds `previousTree` from the session's existing log on --resume, so on a resumed
  // session `previousTree` is already a string before this process has written a single tree of
  // its own. Gating on `previousTree === undefined` there would reuse that stale tree — left over
  // from before the process restarted — for the resumed session's first call, silently skipping the
  // real snapshot that would have caught anything the user or filesystem changed in between.
  let snapshottedThisProcess = false;

  function start(): boolean {
    // Degrade, never fail: refusing to edit files because an *undo* feature is unavailable makes
    // seri unusable on a machine without git, which is far worse than losing undo. The warning
    // fires on the first mutating call, BEFORE the tool runs, and names the consequence in words
    // so a user cannot end the session believing they had checkpoints.
    if (!gitAvailable()) {
      opts.onWarning(
        "git was not found on PATH — edits in this session are not checkpointed and cannot be undone",
      );
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
  // A relative path is resolved against process.cwd(), because that is what the tool itself does
  // with it — writeFile.ts passes the declared path straight to node:fs. Resolving it against the
  // worktree instead put the answer under a different file whenever the two differ: `seri --resume
  // <id>` run from `repo/packages/api` resolved a declared "secrets.txt" to `repo/secrets.txt`,
  // so a root-anchored `/secrets.txt` in .gitignore warned that a file "is gitignored, so /undo
  // cannot restore it" about a file that had in fact been checkpointed — and silence for a
  // genuinely ignored one was just as easy. isIgnored is handed the absolute path for the same
  // reason: run() sets cwd to the worktree, so a relative path would be anchored there a second
  // time.
  function scopeOf(path: string): PathScope {
    const absolute = resolve(path);
    const inside = relative(opts.worktree, absolute);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return "outside";
    return isIgnored(gitDir, opts.worktree, absolute) ? "ignored" : "checkpointed";
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

  // What the first snapshot of the session turned out to cover. One extra spawn, once, on the
  // already-cold first checkpoint — it needs the index, so it cannot run in start().
  //
  // Both conditions below are independent, not mutually exclusive, so they are collected into
  // `messages` and reported via ONE `onWarning` call rather than one each: the TUI's own layout
  // budget (App.tsx's `rows - 1` comment) reserves exactly one spare row to absorb a single
  // mid-render console write without desyncing Ink's line-count bookkeeping for the rest of the
  // session — a worktree that is both large AND has nested repos would otherwise fire two writes
  // in the same tick, one write past that budget.
  function warnAboutScope(): void {
    const { files, nested } = summarizeIndex(gitDir, opts.worktree);
    const messages: string[] = [];

    // `add -A` records a directory that is itself a git repository as a gitlink (mode 160000)
    // holding only its HEAD sha, so the shadow tree does not change AT ALL for edits inside it —
    // measured: editing nested/a.txt and creating nested/b.txt left write-tree returning the
    // identical sha. /undo would then restore the outer files, print "restored …" and leave every
    // change under a submodule or vendored clone in place. Nothing outside git can fix that, so it
    // is said out loud, for the same reason the outside-the-worktree write is.
    if (nested.length > 0) {
      messages.push(
        `${nested.join(", ")} ${nested.length === 1 ? "is a nested git repository" : "are nested git repositories"} — changes inside are not checkpointed and /undo will not revert them`,
      );
    }

    // `add -A` covers the whole worktree minus its ignores, so a project with no .gitignore at all
    // — seri launched in $HOME, or beside an unignored node_modules — hashes every file on every
    // mutating tool call. No limit is imposed: a threshold that silently narrowed the snapshot would
    // be the skipped pre-state this design already refused to accept. The size is reported instead,
    // once, so it is a number the user saw rather than one they find out from a deletion.
    if (files > LARGE_WORKTREE_FILES) {
      messages.push(
        `checkpointing ${files} files under ${opts.worktree} on every file-modifying tool call — /undo's removal pass only covers files it recorded writing; a .gitignore would narrow it`,
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

      // writeTree's own two spawns (`add -A` + `write-tree`) run only when the call might have
      // changed something: `write_file` always might; a bash/powershell call only when its command
      // matches DESTRUCTIVE_COMMAND_PATTERNS; and the very first checkpoint of THIS PROCESS always
      // does regardless of command, because a resumed session's `previousTree` came from an earlier
      // process and cannot be trusted to still match what is on disk now.
      const command = commandOf(context.args);
      const mustSnapshot =
        context.tool === "write_file" ||
        !snapshottedThisProcess ||
        command === undefined ||
        isDestructiveCommand(command);

      // `previousTree` is only reused here when `mustSnapshot` is false, which — per the OR above —
      // means this process has already taken one real snapshot, so `previousTree` is already a
      // string from that call.
      const tree = mustSnapshot ? writeTree(gitDir, opts.worktree) : (previousTree as string);
      if (mustSnapshot) snapshottedThisProcess = true;
      if (mustSnapshot && !scoped) {
        scoped = true;
        warnAboutScope();
      }
      // An unchanged tree means nothing happened since the last checkpoint, so commit-tree and
      // update-ref are skipped — 48.5 ms instead of 107.2 ms, measured. This is also what makes a
      // gated-off bash/powershell call cheap end to end: `tree` above is `previousTree` reused, so
      // this condition is false and neither commit-tree nor update-ref run. Either way the record
      // below is still appended, reusing the previous tree and commit, so the conversation anchor
      // for /rewind is never lost to either optimisation.
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

  // Only write_file's own path is attributable — see writeLedger.ts's own header comment on why
  // bash/powershell output never reaches here. Best-effort and silent on failure: a ledger write
  // that fails (a full disk, a read-only store) only ever makes filterSafeToDelete MORE
  // conservative for this one path, never less safe, so it does not warrant the primary handler's
  // "latch off for the rest of the session" reaction to a genuinely broken store above — this is
  // never the thing standing between a user and undo working at all.
  const onAfterMutation: OnAfterMutation = (context: MutationContext) => {
    if (!enabled || context.tool !== "write_file") return;
    const path = (context.args as { path?: unknown }).path;
    if (typeof path !== "string") return;
    try {
      // Resolved against process.cwd(), same as scopeOf above and for the identical reason:
      // writeFile.ts hands the declared path straight to node:fs, so that is the absolute path
      // that is actually on disk and the one filterSafeToDelete must be able to find again.
      const absolute = resolve(path);
      recordWrite(opts.storeDir, absolute, readFileSync(absolute, "utf8"));
    } catch {}
  };

  // restoreTo's own signal that disk was just forcibly rewritten out from under this closure's
  // `previousTree`/`previousCommit` — see its call site's comment for what goes wrong without it.
  // `previousCommit` is re-resolved from the ref rather than cleared to undefined: restoreTo has
  // already moved the ref to the pre-undo commit by the time this runs, and clearing to undefined
  // would make the NEXT checkpoint a rootless commit instead of one that chains onto it — the same
  // resumed-session derivation start() already does, run again because disk changed a second time
  // without a new process to call start() for it.
  const invalidate = (): void => {
    previousTree = undefined;
    previousCommit = resolveRef(gitDir, sessionRef(opts.sessionId));
    snapshottedThisProcess = false;
  };

  // Object.assign, not `handler as Checkpointer`: the assign's return type is the intersection of
  // its arguments' types, so TypeScript verifies both extra properties are actually present at the
  // call site — a cast would compile even if one were forgotten, silently leaving that property
  // undefined on the object every caller trusts to be a real Checkpointer.
  return Object.assign(handler, { onAfterMutation, invalidate });
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
  for (const record of [...records].reverse())
    if (!byKey.has(key(record))) byKey.set(key(record), record);
  return [...byKey.values()];
}

// What a file-restoring command is about to do, handed to the caller before any of it is done —
// the diff and the deletion list are the reviewable part, and a user learning which of their files
// were removed only afterwards is being told, not asked.
export type RestorePlan = {
  tree: string;
  diff: string;
  restored: string[];
  deleted: string[];
  ignored: string[];
  // Candidates planRestore's own tree diff considered extraneous but the write ledger could not
  // vouch for (writeLedger.ts's own filterSafeToDelete) — no proof seri ever wrote them, or the
  // proof it has no longer matches what is on disk. NOT the same reason as `ignored` (a path the
  // project's own .gitignore excludes) and deliberately not folded into it: conflating "seri
  // can't prove authorship" with "the project declared this out of scope" would misinform the
  // user about why one of their files was left alone.
  preserved: string[];
};

export type RestoreResult = RestorePlan & {
  preUndoCommit: string;
  // A seri subcommand rather than a pasted git incantation. `read-tree` + `checkout-index -a -f`
  // is additive — it recreates files but deletes nothing — so the command printed here used to
  // reconstruct a state that never existed: after the agent deleted `old.ts` and created `new.ts`,
  // `/undo` restored `old.ts` and deleted `new.ts`, and pasting the printed command brought
  // `new.ts` back and LEFT `old.ts`. Routing recovery through `/restore` reuses planRestore and
  // applyRestore, removal pass included, and it is a path a test can exercise — which the raw
  // string, by its third distinct defect (missing crlf flags, missing quoting, missing removal),
  // had shown it was not.
  recoverCommand: string;
};

type RestoreOpts = {
  storeDir: string;
  worktree: string;
  sessionId: string;
  onPlan: (plan: RestorePlan) => void;
};

// Reported so the user is told what the restore did NOT cover, rather than left to infer it from a
// list that silently omits them. Sliced rather than session-wide, because an ignored write from
// twenty tool calls before the checkpoint being restored is not something this restore was ever
// going to have an opinion about — the same reason planRestore subtracts the deleted paths from
// the restored ones.
function ignoredSince(log: CheckpointRecord[], index: number): string[] {
  return newestDistinct(
    log.slice(index).filter((record) => record.kind === "ignored"),
    (record) => record.path,
  ).map((record) => record.path);
}

function restoreTo(opts: RestoreOpts, treeish: string, ignored: string[]): RestoreResult {
  const gitDir = gitDirOf(opts.storeDir);
  // Before the ref moves and before a record is written, so a bad argument costs nothing. Without
  // it, `seri /restore deadbeef` failed with a raw `fatal: bad revision` from the diff, having
  // already minted a commit, advanced the session ref and appended a pre-undo record — and each
  // retry appended another.
  if (!treeExists(gitDir, treeish)) {
    throw new Error(`${treeish} is not a checkpoint in this session's store.`);
  }
  // Taken before anything is touched, so restoring is never the operation that loses work. The
  // parent is the ref itself rather than the last tool record: a second undo would otherwise branch
  // off beside the first pre-undo commit instead of through it, leaving a hash this function
  // already printed to the user unreachable and on gc's clock.
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
  // The removal pass' own positive-proof gate, applied to the PLAN — before onPlan, not just
  // before applyRestore — so what is printed to the user is what actually happens rather than a
  // list the apply step goes on to narrow behind their back. planRestore's `deleted` only knows a
  // path is absent from the target tree; it has no idea whether seri ever wrote it, which is what
  // let a hand-edited or newly-created file the agent never touched get swept up as "extraneous"
  // and deleted by a restore that predates it. filterSafeToDelete narrows the list to paths a
  // write_file ledger entry can still vouch for (writeLedger.ts's own header comment); everything
  // else moves to `preserved` instead of silently vanishing from both the plan and the disk.
  const safeToDelete = new Set(
    filterSafeToDelete(opts.storeDir, opts.worktree, candidates.deleted),
  );
  const deleted = candidates.deleted.filter((path) => safeToDelete.has(path));
  const preserved = candidates.deleted.filter((path) => !safeToDelete.has(path));

  const plan: RestorePlan = {
    tree: treeish,
    // Before planRestore, which rewrites the index. Display only, and non-fatal by design — see
    // diffTree.
    diff: diffTree(gitDir, opts.worktree, treeish),
    restored: candidates.restored,
    deleted,
    ignored,
    preserved,
  };
  opts.onPlan(plan);
  // In a try/finally, not a plain call after: checkout-index rewrites every restored file's
  // on-disk EOL before the loop that deletes `plan.deleted` even starts, so a throw partway
  // through applyRestore (a failed rmSync, a killed git process) still leaves the cache poisoned
  // with pre-restore values unless it is cleared regardless of how applyRestore exits.
  try {
    applyRestore(gitDir, opts.worktree, plan.deleted);
  } finally {
    // checkout-index can rewrite a restored file's on-disk EOL without going through
    // writeFile.ts/readFile.ts (shadowGit.ts's own core.autocrlf=false comment on why), leaving the
    // EOL cache trusting a line-ending style the restore may have just changed — same reason
    // bash.ts/powershell.ts already clear it after every shell call.
    clearEolCache();
  }

  return {
    ...plan,
    preUndoCommit,
    recoverCommand: `seri --resume ${opts.sessionId} /restore ${preUndoCommit}`,
  };
}

export function undoFiles(opts: RestoreOpts & { steps: number }): RestoreResult {
  const log = readLog(opts.storeDir, opts.sessionId);
  // `pre-undo` records are excluded here — they describe state an undo replaced, not a point the
  // user asked to be able to return to, and stepping onto one would make `/undo 2` mean "undo the
  // undo". They are still part of the commit chain; see the parent in restoreTo.
  const targets = newestDistinct(toolRecords(log), (record) => record.tree);
  const target = targets[opts.steps - 1];
  if (target === undefined) {
    throw new Error(
      `This session has ${targets.length} checkpoint(s) to undo to; asked for ${opts.steps}.`,
    );
  }

  // Everything logged for the tool call being restored to, and everything after it. The `ignored`
  // record for a call is appended immediately before its `tool` record, so cutting at the tool
  // record would drop the very write that checkpoint was taken in front of.
  const from = log.findIndex(
    (record) => "toolCallId" in record && record.toolCallId === target.toolCallId,
  );
  return restoreTo(opts, target.tree, ignoredSince(log, from));
}

// The other end of `recoverCommand`: put back a commit this session recorded, whatever it was.
// Every ignored write in the session is reported, because an arbitrary commit has no position in
// the log to measure "since" from.
export function restoreCommit(opts: RestoreOpts & { commit: string }): RestoreResult {
  return restoreTo(opts, opts.commit, ignoredSince(readLog(opts.storeDir, opts.sessionId), 0));
}

// Reads the log and nothing else — it has no path to shadowGit, so "rewind leaves the filesystem
// byte-identical" is structural rather than something the code has to remember to do.
export function rewindConversation(opts: { storeDir: string; sessionId: string; steps: number }): {
  rewindTo: number;
} {
  const log = readLog(opts.storeDir, opts.sessionId);

  // Both barriers mean the same thing to an anchor: the array it indexed is gone. Compaction
  // splices it; a rewind truncates it and the messages that follow reuse the freed indices, which
  // is the more dangerous of the two because a stale anchor then still LANDS — on a different
  // message — instead of falling off the end where clamping would catch it. Refusing is the honest
  // answer; slicing on either would hand back garbage.
  // `findLastIndex` would say this in one word, but it is ES2023 and this package compiles against
  // the ES2022 lib.
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
