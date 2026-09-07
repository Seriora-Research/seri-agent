// git reads global core.fsmonitor even with --git-dir; -c core.fsmonitor=false outranks it.
export function gitArgv(args: readonly string[]): string[] {
  return ["-c", "core.fsmonitor=false", ...args];
}
