// core.fsmonitor names a helper git runs whenever it reads the index (`status`, `add`, `ls-files`,
// `diff`). The user's global config can set it to an arbitrary program. Measured: `git add -A`
// with `--git-dir` pointed at the shadow store still executed a global helper, because git reads
// global config regardless of --git-dir. `-c` outranks local, global, GIT_CONFIG_COUNT, and
// GIT_CONFIG_PARAMETERS.
export function gitArgv(args: readonly string[]): string[] {
  return ["-c", "core.fsmonitor=false", ...args];
}
