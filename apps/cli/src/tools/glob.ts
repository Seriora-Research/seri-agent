import { assertSearchPath, MAX_FILE_RESULTS, outputLines, runRipgrep } from "./runRipgrep";
import { ToolSpawnEnv } from "./toolSpawnEnv";

export type GlobResult = { files: string[]; truncated: boolean };

export async function glob(
  pattern: string,
  opts: { path: string; env?: ToolSpawnEnv },
  signal?: AbortSignal,
): Promise<GlobResult> {
  await assertSearchPath(opts.path);

  // `--` stops rg from parsing a dash-leading path as a flag.
  const { stdout, truncated: overflowed } = await runRipgrep(
    ["--files", "-g", pattern, "--", opts.path],
    signal,
    opts.env ?? ToolSpawnEnv.inherited,
  );
  const files = outputLines(stdout, overflowed);

  return {
    files: files.slice(0, MAX_FILE_RESULTS),
    truncated: overflowed || files.length > MAX_FILE_RESULTS,
  };
}
