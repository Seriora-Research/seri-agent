import {
  assertSearchPath,
  MAX_FILE_RESULTS,
  MAX_RESULTS,
  outputLines,
  runRipgrep,
} from "./runRipgrep";

// rg emits `text` for UTF-8 and base64 `bytes` otherwise.
type RgText = { text: string } | { bytes: string };

type RgMatchEvent = {
  type: "match";
  data: { path: RgText; line_number: number; lines: RgText };
};

export type GrepMode = "files_with_matches" | "content" | "count";

export type GrepResult = {
  mode: GrepMode;
  files?: string[];
  matches?: { file: string; line: number; text: string }[];
  counts?: { file: string; count: number }[];
  truncated: boolean;
};

function decodeRgText(value: RgText): string {
  return "text" in value ? value.text : Buffer.from(value.bytes, "base64").toString("utf8");
}

export async function grep(
  pattern: string,
  opts: { path: string; glob?: string; mode?: GrepMode },
  signal?: AbortSignal,
): Promise<GrepResult> {
  await assertSearchPath(opts.path);

  const mode = opts.mode ?? "files_with_matches";

  // rg omits the filename when searching exactly one file.
  const args =
    mode === "content"
      ? ["--json"]
      : mode === "count"
        ? ["--count", "--with-filename"]
        : ["--files-with-matches"];
  if (opts.glob) args.push("-g", opts.glob);
  // `--` stops rg from parsing a pattern like --force as a flag.
  args.push("--", pattern, opts.path);

  const { stdout, truncated: overflowed } = await runRipgrep(args, signal);
  const lines = outputLines(stdout, overflowed);

  if (mode === "files_with_matches") {
    return {
      mode,
      files: lines.slice(0, MAX_FILE_RESULTS),
      truncated: overflowed || lines.length > MAX_FILE_RESULTS,
    };
  }

  if (mode === "count") {
    // rg prints `path:count`; split from the right because Windows paths contain a colon.
    const counts = lines.map((line) => {
      const split = line.lastIndexOf(":");
      return { file: line.slice(0, split), count: Number(line.slice(split + 1)) };
    });
    return {
      mode,
      counts: counts.slice(0, MAX_FILE_RESULTS),
      truncated: overflowed || counts.length > MAX_FILE_RESULTS,
    };
  }

  const matches: { file: string; line: number; text: string }[] = [];
  for (const line of lines) {
    const event = JSON.parse(line) as { type: string };
    if (event.type !== "match") continue;

    const { data } = event as RgMatchEvent;
    matches.push({
      file: decodeRgText(data.path),
      line: data.line_number,
      text: decodeRgText(data.lines).replace(/\r?\n$/, ""),
    });

    if (matches.length > MAX_RESULTS) break;
  }

  return {
    mode,
    matches: matches.slice(0, MAX_RESULTS),
    truncated: overflowed || matches.length > MAX_RESULTS,
  };
}
