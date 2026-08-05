import { assertSearchPath, MAX_FILE_RESULTS, outputLines, runRipgrep } from "./runRipgrep";

export type GlobResult = { files: string[]; truncated: boolean };

export async function glob(pattern: string, opts: { path: string }, signal?: AbortSignal): Promise<GlobResult> {
  assertSearchPath(opts.path);

  // `--` for the same reason grep passes it: without it a path that starts with a dash is read
  // by rg as an unrecognized flag, which exits 2 and reaches the model as a thrown error.
  const { stdout, truncated: overflowed } = await runRipgrep(["--files", "-g", pattern, "--", opts.path], signal);
  const files = outputLines(stdout, overflowed);

  return { files: files.slice(0, MAX_FILE_RESULTS), truncated: overflowed || files.length > MAX_FILE_RESULTS };
}
