// core.fsmonitor names a helper git runs during an index refresh (`status`, `add`, `ls-files`,
// `diff`). A handed-over `.git/config` can set it to an arbitrary program, and so can the user's
// global config. Measured: `git add -A` with `--git-dir` pointed at the shadow store still executed
// a global helper, because git reads global config regardless of --git-dir. `-c` outranks local,
// global, GIT_CONFIG_COUNT, and GIT_CONFIG_PARAMETERS. One function so spawnGit, probeGit, and
// readGitHead cannot omit it.
export function gitArgv(args: readonly string[]): string[] {
  return ["-c", "core.fsmonitor=false", ...args];
}
