import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { gitArgv } from "./gitArgv";

// spawnSync reports a filled maxBuffer as status: null with empty stderr, indistinguishable from a crashed git.
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

// Git for Windows' installer sets core.autocrlf=true in system config.
// commit-tree refuses to run without user.name/email, and GitHub runners have none.
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

// An inherited GIT_INDEX_FILE redirects `add -A` into the user's index.
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

function spawnGit(args: string[], cwd: string | undefined): GitResult {
  const result = spawnSync("git", gitArgv(args), {
    encoding: "utf8",
    cwd,
    env: childEnv(),
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (result.error) throw new Error(`failed to run git: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// `checkout-index` and `ls-files` report paths relative to cwd, so run() must spawn from the worktree.
function run(gitDir: string, workTree: string | undefined, args: string[]): GitResult {
  const prefix = [...SHADOW_CONFIG, `--git-dir=${gitDir}`];
  if (workTree !== undefined) prefix.push(`--work-tree=${workTree}`);
  return spawnGit([...prefix, ...args], workTree);
}

// gitignore(5) reads .gitignore only up to the work-tree top, so --work-tree must be the project root.
export function projectRoot(from: string): string {
  const result = spawnGit(["rev-parse", "--show-toplevel"], from);
  const top = result.stdout.trim();
  // --show-toplevel answers with forward slashes on Windows; resolve() converts to the platform form.
  return result.status === 0 && top !== "" ? resolve(top) : resolve(from);
}

// `.git` is a file in a linked worktree or submodule; `--git-path info/exclude` locates the real exclude file.
function localExcludePath(root: string): string | undefined {
  const result = spawnGit(["rev-parse", "--git-path", "info/exclude"], root);
  return result.status === 0 ? resolve(root, result.stdout.trim()) : undefined;
}

function git(gitDir: string, workTree: string | undefined, args: string[]): string {
  const result = run(gitDir, workTree, args);
  if (result.status !== 0)
    throw new Error(`git ${args[0]} exited with code ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

let available: boolean | undefined;

export function isGitAvailable(): boolean {
  available ??= probeGit();
  return available;
}

function probeGit(): boolean {
  try {
    return spawnGit(["--version"], undefined).status === 0;
  } catch {
    return false;
  }
}

export function initShadow(gitDir: string): void {
  git(gitDir, undefined, ["init", "--bare"]);

  for (const [key, value] of [
    ["core.autocrlf", "false"],
    ["core.safecrlf", "false"],
    ["core.eol", "lf"],
  ]) {
    git(gitDir, undefined, ["config", key as string, value as string]);
  }

  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "attributes"), "* -text\n");
}

// `--exclude-standard` reads info/exclude from $GIT_DIR, which here is the shadow store.
export function mirrorLocalExcludes(gitDir: string, root: string): void {
  const source = localExcludePath(root);
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(
    join(gitDir, "info", "exclude"),
    source !== undefined && existsSync(source) ? readFileSync(source) : "",
  );
}

export function resolveRef(gitDir: string, ref: string): string | undefined {
  const result = run(gitDir, undefined, ["rev-parse", "--verify", "--quiet", ref]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function treeExists(gitDir: string, treeish: string): boolean {
  return (
    run(gitDir, undefined, ["rev-parse", "--verify", "--quiet", `${treeish}^{tree}`]).status === 0
  );
}

// `git add -- missing` exits 128; `git add -- ignored` exits 1.
export function writeTree(gitDir: string, workTree: string, paths?: readonly string[]): string {
  if (paths === undefined) {
    git(gitDir, workTree, ["add", "-A"]);
  } else {
    const existing = paths.filter((path) =>
      existsSync(isAbsolute(path) ? path : join(workTree, path)),
    );
    if (existing.length > 0) git(gitDir, workTree, ["add", "--", ...existing]);
  }
  return git(gitDir, workTree, ["write-tree"]).trim();
}

// git add -A records a nested repo as a gitlink (mode 160000) holding only HEAD.
export function summarizeIndex(
  gitDir: string,
  workTree: string,
): { files: number; nested: string[] } {
  const entries = paths(git(gitDir, workTree, ["ls-files", "--stage", "-z"]));
  return {
    files: entries.length,
    nested: entries
      .filter((entry) => entry.startsWith("160000 "))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
  };
}

export function commitTree(
  gitDir: string,
  workTree: string,
  tree: string,
  parent?: string,
): string {
  const args = ["commit-tree", tree, "-m", "seri checkpoint"];
  if (parent !== undefined) args.push("-p", parent);
  return git(gitDir, workTree, args).trim();
}

export function updateRef(gitDir: string, ref: string, commit: string): void {
  git(gitDir, undefined, ["update-ref", ref, commit]);
}

// `gc` packs refs, and a packed ref has no file to stat.
export function listSessionRefs(gitDir: string): string[] {
  const out = git(gitDir, undefined, [
    "for-each-ref",
    "--sort=committerdate",
    "--format=%(refname)",
    "refs/seri/sessions",
  ]);
  return out.split("\n").filter(Boolean);
}

export function deleteRef(gitDir: string, ref: string): void {
  git(gitDir, undefined, ["update-ref", "-d", ref]);
}

// Default prune expiry, never --prune=now: git documents that as unsafe with a concurrent writer.
export function gc(gitDir: string): void {
  git(gitDir, undefined, ["gc", "--quiet"]);
}

// core.quotePath defaults to true, so without -z git emits quoted octal escapes for non-ASCII paths.
function paths(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

export function planRestore(
  gitDir: string,
  workTree: string,
  tree: string,
): { restored: string[]; deleted: string[] } {
  const changed = paths(git(gitDir, workTree, ["diff", "--name-only", "-z", tree]));

  git(gitDir, workTree, ["read-tree", tree]);
  const deleted = paths(
    git(gitDir, workTree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );

  const removed = new Set(deleted);
  return { restored: changed.filter((path) => !removed.has(path)), deleted };
}

// `checkout-index -a -f` is additive: it recreates and overwrites but does not remove files created after the snapshot.
export function applyRestore(gitDir: string, workTree: string, deleted: string[]): void {
  git(gitDir, workTree, ["checkout-index", "-a", "-f"]);
  for (const path of deleted) rmSync(join(workTree, path), { force: true });
}

export function diffTree(gitDir: string, workTree: string, tree: string): string {
  try {
    return git(gitDir, workTree, ["diff", tree]);
  } catch (err) {
    return `(diff not shown: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export function isIgnored(gitDir: string, workTree: string, path: string): boolean {
  const result = run(gitDir, workTree, ["check-ignore", "-q", "--", path]);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore exited with code ${result.status}: ${result.stderr.trim()}`);
  }
  return result.status === 0;
}
