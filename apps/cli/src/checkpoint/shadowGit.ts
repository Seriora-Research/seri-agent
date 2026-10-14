import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ToolSpawnEnv } from "../tools/toolSpawnEnv";
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

function childEnv(env: ToolSpawnEnv): NodeJS.ProcessEnv {
  const replaced = env.spawnOptions().env;
  const out = { ...(replaced ?? process.env) };
  for (const name of INHERITED_GIT_VARS) delete out[name];
  return out;
}

type GitResult = { status: number | null; stdout: string; stderr: string };

function spawnGit(
  args: string[],
  cwd: string | undefined,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): GitResult {
  const result = spawnSync("git", gitArgv(args), {
    encoding: "utf8",
    cwd,
    env: childEnv(env),
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (result.error) throw new Error(`failed to run git: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// `checkout-index` and `ls-files` report paths relative to cwd, so run() must spawn from the worktree.
function run(
  gitDir: string,
  workTree: string | undefined,
  args: string[],
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): GitResult {
  const prefix = [...SHADOW_CONFIG, `--git-dir=${gitDir}`];
  if (workTree !== undefined) prefix.push(`--work-tree=${workTree}`);
  return spawnGit([...prefix, ...args], workTree, env);
}

// gitignore(5) reads .gitignore only up to the work-tree top, so --work-tree must be the project root.
export function projectRoot(from: string, env: ToolSpawnEnv = ToolSpawnEnv.inherited): string {
  const result = spawnGit(["rev-parse", "--show-toplevel"], from, env);
  const top = result.stdout.trim();
  // --show-toplevel answers with forward slashes on Windows; resolve() converts to the platform form.
  return result.status === 0 && top !== "" ? resolve(top) : resolve(from);
}

// `.git` is a file in a linked worktree or submodule; `--git-path info/exclude` locates the real exclude file.
function localExcludePath(
  root: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): string | undefined {
  const result = spawnGit(["rev-parse", "--git-path", "info/exclude"], root, env);
  return result.status === 0 ? resolve(root, result.stdout.trim()) : undefined;
}

function git(
  gitDir: string,
  workTree: string | undefined,
  args: string[],
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): string {
  const result = run(gitDir, workTree, args, env);
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

export function initShadow(gitDir: string, env: ToolSpawnEnv = ToolSpawnEnv.inherited): void {
  git(gitDir, undefined, ["init", "--bare"], env);

  for (const [key, value] of [
    ["core.autocrlf", "false"],
    ["core.safecrlf", "false"],
    ["core.eol", "lf"],
  ]) {
    git(gitDir, undefined, ["config", key as string, value as string], env);
  }

  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "attributes"), "* -text\n");
}

// `--exclude-standard` reads info/exclude from $GIT_DIR, which here is the shadow store.
export function mirrorLocalExcludes(
  gitDir: string,
  root: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): void {
  const source = localExcludePath(root, env);
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(
    join(gitDir, "info", "exclude"),
    source !== undefined && existsSync(source) ? readFileSync(source) : "",
  );
}

export function resolveRef(
  gitDir: string,
  ref: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): string | undefined {
  const result = run(gitDir, undefined, ["rev-parse", "--verify", "--quiet", ref], env);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function treeExists(
  gitDir: string,
  treeish: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): boolean {
  return (
    run(gitDir, undefined, ["rev-parse", "--verify", "--quiet", `${treeish}^{tree}`], env)
      .status === 0
  );
}

// `git add -- missing` exits 128; `git add -- ignored` exits 1.
export function writeTree(
  gitDir: string,
  workTree: string,
  paths?: readonly string[],
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): string {
  if (paths === undefined) {
    git(gitDir, workTree, ["add", "-A"], env);
  } else {
    const existing = paths.filter((path) =>
      existsSync(isAbsolute(path) ? path : join(workTree, path)),
    );
    if (existing.length > 0) git(gitDir, workTree, ["add", "--", ...existing], env);
  }
  return git(gitDir, workTree, ["write-tree"], env).trim();
}

// git add -A records a nested repo as a gitlink (mode 160000) holding only HEAD.
export function summarizeIndex(
  gitDir: string,
  workTree: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): { files: number; nested: string[] } {
  const entries = paths(git(gitDir, workTree, ["ls-files", "--stage", "-z"], env));
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
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): string {
  const args = ["commit-tree", tree, "-m", "seri checkpoint"];
  if (parent !== undefined) args.push("-p", parent);
  return git(gitDir, workTree, args, env).trim();
}

export function updateRef(
  gitDir: string,
  ref: string,
  commit: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): void {
  git(gitDir, undefined, ["update-ref", ref, commit], env);
}

// `gc` packs refs, and a packed ref has no file to stat.
export function listSessionRefs(
  gitDir: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): string[] {
  const out = git(
    gitDir,
    undefined,
    ["for-each-ref", "--sort=committerdate", "--format=%(refname)", "refs/seri/sessions"],
    env,
  );
  return out.split("\n").filter(Boolean);
}

export function deleteRef(
  gitDir: string,
  ref: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): void {
  git(gitDir, undefined, ["update-ref", "-d", ref], env);
}

// Default prune expiry, never --prune=now: git documents that as unsafe with a concurrent writer.
export function gc(gitDir: string, env: ToolSpawnEnv = ToolSpawnEnv.inherited): void {
  git(gitDir, undefined, ["gc", "--quiet"], env);
}

// core.quotePath defaults to true, so without -z git emits quoted octal escapes for non-ASCII paths.
function paths(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

export function planRestore(
  gitDir: string,
  workTree: string,
  tree: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): { restored: string[]; deleted: string[] } {
  const changed = paths(git(gitDir, workTree, ["diff", "--name-only", "-z", tree], env));

  git(gitDir, workTree, ["read-tree", tree], env);
  const deleted = paths(
    git(gitDir, workTree, ["ls-files", "--others", "--exclude-standard", "-z"], env),
  );

  const removed = new Set(deleted);
  return { restored: changed.filter((path) => !removed.has(path)), deleted };
}

// `checkout-index -a -f` is additive: it recreates and overwrites but does not remove files created after the snapshot.
export function applyRestore(
  gitDir: string,
  workTree: string,
  deleted: string[],
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): void {
  git(gitDir, workTree, ["checkout-index", "-a", "-f"], env);
  for (const path of deleted) rmSync(join(workTree, path), { force: true });
}

export function diffTree(
  gitDir: string,
  workTree: string,
  tree: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): string {
  try {
    return git(gitDir, workTree, ["diff", tree], env);
  } catch (err) {
    return `(diff not shown: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export function isIgnored(
  gitDir: string,
  workTree: string,
  path: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): boolean {
  const result = run(gitDir, workTree, ["check-ignore", "-q", "--", path], env);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore exited with code ${result.status}: ${result.stderr.trim()}`);
  }
  return result.status === 0;
}
