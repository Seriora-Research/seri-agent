import { runRipgrep } from "./runRipgrep";

export function glob(pattern: string, opts: { path: string }): string[] {
  const stdout = runRipgrep(["--files", "-g", pattern, opts.path]);
  return stdout.split("\n").filter(Boolean);
}
