import { MAX_RESULTS, runRipgrep } from "./runRipgrep";

export type GlobResult = { files: string[]; truncated: boolean };

export function glob(pattern: string, opts: { path: string }): GlobResult {
  const { stdout, truncated: overflowed } = runRipgrep(["--files", "-g", pattern, opts.path]);

  const files = stdout.split("\n").filter(Boolean);
  // A full buffer cuts mid-path, so the trailing line is an incomplete filename.
  if (overflowed) files.pop();

  return { files: files.slice(0, MAX_RESULTS), truncated: overflowed || files.length > MAX_RESULTS };
}
