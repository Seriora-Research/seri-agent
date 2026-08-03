import { MAX_FILE_RESULTS, MAX_RESULTS, outputLines, runRipgrep } from "./runRipgrep";

// rg emits `text` when a value is valid UTF-8 and falls back to base64 `bytes` when it is
// not, for both matched lines and file paths.
type RgText = { text: string } | { bytes: string };

type RgMatchEvent = {
  type: "match";
  data: { path: RgText; line_number: number; lines: RgText };
};

export type GrepMode = "files_with_matches" | "content" | "count";

// One field per mode, and only the mode's own field is set — so the JSON the model sees is
// exactly the shape for the mode it asked for, with no empty keys spending tokens. Kept as
// optional fields rather than a discriminated union deliberately: a union forces every
// consumer through a generic signature or a narrowing check, and there are three consumers.
export type GrepResult = {
  mode: GrepMode;
  files?: string[];
  matches?: { file: string; line: number; text: string }[];
  counts?: { file: string; count: number }[];
  truncated: boolean;
};

// Reading `.text` unconditionally meant a single latin-1 line anywhere under the search
// path threw and discarded every match from every other file — the same "one problem loses
// the whole search" failure this tool exists to stop having.
function decodeRgText(value: RgText): string {
  return "text" in value ? value.text : Buffer.from(value.bytes, "base64").toString("utf8");
}

export function grep(
  pattern: string,
  opts: { path: string; glob?: string; mode?: GrepMode },
): GrepResult {
  // Defaults to file names for the same reason Claude Code does: it answers "where does this
  // live" — most of what a search is actually for — at a fraction of the tokens, and a list
  // of paths fits under the cap far more often than a list of matched lines does.
  const mode = opts.mode ?? "files_with_matches";

  const args = mode === "content" ? ["--json"] : mode === "count" ? ["--count"] : ["--files-with-matches"];
  if (opts.glob) args.push("-g", opts.glob);
  args.push(pattern, opts.path);

  const { stdout, truncated: overflowed } = runRipgrep(args);
  const lines = outputLines(stdout, overflowed);

  if (mode === "files_with_matches") {
    return {
      mode,
      files: lines.slice(0, MAX_FILE_RESULTS),
      truncated: overflowed || lines.length > MAX_FILE_RESULTS,
    };
  }

  if (mode === "count") {
    // rg prints `path:count`, and on Windows the path itself contains a colon, so the split
    // has to come from the right.
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

    // One event past the cap is all it takes to know there was more. A broad pattern over a
    // monorepo emits tens of thousands of these; parsing them all to throw away all but the
    // first hundred is pure waste.
    if (matches.length > MAX_RESULTS) break;
  }

  return { mode, matches: matches.slice(0, MAX_RESULTS), truncated: overflowed || matches.length > MAX_RESULTS };
}
