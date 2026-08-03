import { MAX_FILE_RESULTS, outputLines, runRipgrep } from "./runRipgrep";

export type GlobResult = { files: string[]; truncated: boolean };

export function glob(pattern: string, opts: { path: string }): GlobResult {
  const { stdout, truncated: overflowed } = runRipgrep(["--files", "-g", pattern, opts.path]);
  const files = outputLines(stdout, overflowed);

  return { files: files.slice(0, MAX_FILE_RESULTS), truncated: overflowed || files.length > MAX_FILE_RESULTS };
}
