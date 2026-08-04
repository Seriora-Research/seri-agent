import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// spawnSync buffers the child's entire stdout and kills it the moment the buffer fills, and the
// overflow arrives as `status: null` with an empty stderr — indistinguishable from a crashed git.
// `git diff` against a checkpoint is the one command here that can produce real volume, so this
// borrows runRipgrep.ts's 8 MB rather than Node's 1 MB default. spawnCollect is deliberately not
// used: it has neither `cwd` nor `env` (both mandatory below) and caps each stream at 30 000
// characters, which would silently truncate a diff the user is being asked to review.
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

// Applied to every single invocation, from this one place, because the cost of a call site
// forgetting them is silent corruption of exactly the files the agent edited:
//
//   - core.autocrlf: Git for Windows' installer sets this to `true` in the system config, so it is
//     on for most Windows users and on the windows-latest CI runner. Measured on this repo's
//     dev box: an LF file snapshotted and restored through `add -A` + `checkout-index -a -f` came
//     back as CRLF (2751a3a2… → 4ad3ef64…). Worse, the damage is selective — `checkout-index`
//     skips files whose stat still matches the index, so only the files that were actually edited
//     get mangled. It must be false at BOTH snapshot and restore time: with `true` at snapshot the
//     CRLF files are normalised to LF in the object database, so flipping it only at restore
//     corrupts the other direction. Measured caveat, so this is not read as stronger than it is:
//     with initShadow's `info/attributes` in place these three are belt to its braces — flipping
//     core.autocrlf back to true leaves every round trip byte-identical, because a path attribute
//     outranks config. They are what protects a store whose attributes file went missing.
//   - user.name / user.email: `commit-tree` refuses to run without an identity ("Please tell me
//     who you are"), and GitHub's runners have no global one. Supplying it per-invocation keeps
//     the shadow store from depending on the user's git identity at all.
//   - gc.auto=0: git's automatic gc would otherwise be free to fire in the middle of a tool call,
//     turning a ~100 ms snapshot into a multi-hundred-millisecond stall at random. Retention runs
//     `gc` explicitly instead, once per session, off the hot path.
//
// Measured cost of carrying twelve `-c` arguments on every spawn: 21.3 ms vs 21.8 ms for a bare
// `git --version`, i.e. inside the noise.
const SHADOW_CONFIG = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "user.name=seri",
  "-c",
  "user.email=seri@localhost",
  "-c",
  "gc.auto=0",
];

// seri can be launched from inside a git hook or a `git rebase -x` step, which export these into
// every child. An inherited GIT_INDEX_FILE would redirect our `add -A` straight into the USER's
// index — staging their whole worktree as a side effect of an edit — and GIT_DIR/GIT_WORK_TREE
// would fight the flags below. Nothing else in this design would catch that, so they are removed
// from the child environment rather than merely overridden.
// GIT_CONFIG_COUNT is here for a narrower reason: it is a second route to setting
// core.autocrlf=true underneath the -c flags, which would defeat the crlf defence specifically.
// Removing it is enough on its own — git ignores GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n without a
// count to say how many of them there are.
const INHERITED_GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG_COUNT",
];

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of INHERITED_GIT_VARS) delete env[name];
  return env;
}

type GitResult = { status: number | null; stdout: string; stderr: string };

// `cwd: workTree` as well as `--work-tree`: `checkout-index` and `ls-files` report paths relative
// to the current directory, and running from outside the worktree makes them relative to a
// directory the caller never named.
function run(gitDir: string, workTree: string | undefined, args: string[]): GitResult {
  const prefix = [...SHADOW_CONFIG, `--git-dir=${gitDir}`];
  if (workTree !== undefined) prefix.push(`--work-tree=${workTree}`);

  const result = spawnSync("git", [...prefix, ...args], {
    encoding: "utf8",
    cwd: workTree,
    env: childEnv(),
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (result.error) throw new Error(`failed to run git: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(gitDir: string, workTree: string | undefined, args: string[]): string {
  const result = run(gitDir, workTree, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} exited with code ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

let available: boolean | undefined;

// Resolved once, on the first mutating tool call, mirroring resolveRg()'s lazy-once shape:
// `--version`, `login`, `config` and any read-only session never spawn git at all. There is
// deliberately no minimum-version check — every command this module uses (`init --bare`, `add -A`,
// `write-tree`, `commit-tree`, `update-ref`, `read-tree`, `ls-files`, `checkout-index`,
// `check-ignore`, `gc`) predates git 1.7 (2010), and a machine with a git that old cannot run Bun.
// A version gate here would be code that can never fire.
export function isGitAvailable(): boolean {
  available ??= probeGit();
  return available;
}

function probeGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

export function initShadow(gitDir: string): void {
  git(gitDir, undefined, ["init", "--bare"]);

  // The same crlf settings the -c flags above carry, persisted into the store's own config. Those
  // flags only protect calls made through this module, and /undo prints a plain-git command for
  // recovering the state it replaced — run on a Windows box, that would otherwise inherit the
  // installer's system-wide core.autocrlf=true.
  //
  // Measured, so it is not oversold: the `* -text` below is already sufficient on its own — the
  // printed command round-trips an LF file byte-identically with these three removed and
  // core.autocrlf=true in the system config, because a path attribute outranks config. This is the
  // second layer under the one command a user pastes when they need their work back, and it costs
  // three spawns once per session on the already-cold first checkpoint.
  for (const [key, value] of [
    ["core.autocrlf", "false"],
    ["core.safecrlf", "false"],
    ["core.eol", "lf"],
  ]) {
    git(gitDir, undefined, ["config", key as string, value as string]);
  }

  // The second, independent CRLF vector. A worktree `.gitattributes` saying `* text eol=crlf`
  // overrides the core.* config and re-enables conversion — measured: `lf.txt` 2751a3a2 →
  // 4ad3ef64 with the config already applied. `$GIT_DIR/info/attributes` has the highest
  // precedence in gitattributes(5), so `* -text` there neutralises it. Side effect:
  // attribute-driven diff drivers are disabled inside the shadow repo, which only affects the
  // cosmetics of /undo's diff.
  //
  // mkdirSync first rather than trusting `init --bare` to have made `info/`: a user whose
  // init.templateDir omits it would otherwise get an ENOENT here, and this mitigation is the one
  // that must never be conditional.
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "attributes"), "* -text\n");
}

// The tip of a session's commit chain, or undefined when the session has no ref yet. This is the
// authority on "what should the next commit's parent be" — deriving it from the log instead means
// two rules for one fact, and they disagree the moment a record that carries a commit is filtered
// out of one of them.
export function resolveRef(gitDir: string, ref: string): string | undefined {
  const result = run(gitDir, undefined, ["rev-parse", "--verify", "--quiet", ref]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

// `add -A` then `write-tree` — two spawns, no `git commit`. Measured on this repo: the porcelain
// `add` + `commit` path is 233.5 ms against 107.2 ms for the four-command plumbing path, because
// `git commit` alone costs ~217 ms and neither --no-verify nor gc.auto=0 moves it.
//
// The worktree's own `.gitignore` is honoured even though the git-dir is foreign (verified on
// Windows and WSL), and no shadow-side exclude is added on top of it. That is deliberate: an
// ignored path is the only declaration a project makes about what is not its source, and
// overriding it would mean copying the user's `.env` into <configDir> — outside the repo, where
// no `.gitignore`, no `git clean` and no repo deletion will ever reach it. That is a security
// regression traded for an undo nobody asked for. `.claude/` and `dist/` fall outside the undo for
// the same reason.
export function writeTree(gitDir: string, workTree: string): string {
  git(gitDir, workTree, ["add", "-A"]);
  return git(gitDir, workTree, ["write-tree"]).trim();
}

export function commitTree(gitDir: string, workTree: string, tree: string, parent?: string): string {
  const args = ["commit-tree", tree, "-m", "seri checkpoint"];
  if (parent !== undefined) args.push("-p", parent);
  return git(gitDir, workTree, args).trim();
}

export function updateRef(gitDir: string, ref: string, commit: string): void {
  git(gitDir, undefined, ["update-ref", ref, commit]);
}

// Sorted oldest-first by the tip commit's date, which for a session ref is the time of its last
// snapshot. Not by the ref file's mtime: `gc` packs refs, and a packed ref has no file to stat.
export function listSessionRefs(gitDir: string): string[] {
  const out = git(gitDir, undefined, ["for-each-ref", "--sort=committerdate", "--format=%(refname)", "refs/seri/sessions"]);
  return out.split("\n").filter(Boolean);
}

export function deleteRef(gitDir: string, ref: string): void {
  git(gitDir, undefined, ["update-ref", "-d", ref]);
}

// Default prune expiry, never --prune=now: the latter is documented as unsafe with a concurrent
// writer, and two seri processes in one project is an ordinary situation. Nothing recoverable is
// lost by the delay — reachability is decided by refs, and the expiry window only governs when the
// disk is reclaimed.
export function gc(gitDir: string): void {
  git(gitDir, undefined, ["gc", "--quiet"]);
}

// `-z` on every command that reports paths, and never a `\n` split. core.quotePath defaults to
// true, so without it git emits `"caf\303\251-\303\261.txt"` — surrounding quotes and octal
// escapes included — for any path with a non-ASCII byte, a control character, a quote or a
// backslash. Handing that raw string to rmSync fails with EFAULT on Windows *after* read-tree and
// before checkout-index, leaving nothing restored; on POSIX `force: true` swallows the ENOENT and
// the path is still reported as deleted, so the report claims a deletion that did not happen. NUL
// separation also covers a filename containing a newline, which no `\n` split can.
function paths(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

// Split from the apply below so `/undo` can show the user what it is about to delete before it
// deletes it. `read-tree` only rewrites the index, so the worktree is untouched until
// applyRestore runs.
//
// The removal list comes from git's own `ls-files --others --exclude-standard` against the target
// tree, so it is computed from the tree rather than from what a tool claimed to touch, and can
// never contain a gitignored path.
export function planRestore(gitDir: string, workTree: string, tree: string): { restored: string[]; deleted: string[] } {
  const changed = paths(git(gitDir, workTree, ["diff", "--name-only", "-z", tree]));

  git(gitDir, workTree, ["read-tree", tree]);
  const deleted = paths(git(gitDir, workTree, ["ls-files", "--others", "--exclude-standard", "-z"]));

  // A path that is about to be deleted also shows up in the diff (the index still held it), so it
  // is subtracted here — reporting a file as both restored and deleted is the kind of thing that
  // makes a user stop believing the report.
  const removed = new Set(deleted);
  return { restored: changed.filter((path) => !removed.has(path)), deleted };
}

// `checkout-index -a -f` is additive: it recreates deleted files and overwrites modified ones, but
// it does NOT remove a file created after the snapshot (nor does `checkout -f HEAD` — both
// measured). Without the removal pass, undo would leave the agent's new files on disk while
// reporting success, which is the worst failure a trust feature can have.
//
// Empty directories left behind by the removal are git's own behaviour — it does not track
// directories — so `newdir/` survives with its contents gone. Asserted in the tests rather than
// worked around.
//
// Not defensible from here: a backgrounded `bash` command still writing while `checkout-index`
// runs. spawnCollect detaches into its own process group and resolves on the direct child's
// close, so nothing outside the shell can know a grandchild is still going.
export function applyRestore(gitDir: string, workTree: string, deleted: string[]): void {
  for (const path of deleted) rmSync(join(workTree, path), { force: true });
  git(gitDir, workTree, ["checkout-index", "-a", "-f"]);
}

export function diffTree(gitDir: string, workTree: string, tree: string): string {
  return git(gitDir, workTree, ["diff", tree]);
}

// exit 0 = ignored, exit 1 = not ignored. Measured at 23.5 ms per path.
export function isIgnored(gitDir: string, workTree: string, path: string): boolean {
  const result = run(gitDir, workTree, ["check-ignore", "-q", "--", path]);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore exited with code ${result.status}: ${result.stderr.trim()}`);
  }
  return result.status === 0;
}
