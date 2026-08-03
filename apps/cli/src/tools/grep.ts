import { MAX_RESULTS, runRipgrep } from "./runRipgrep";

// rg emits `text` when a value is valid UTF-8 and falls back to base64 `bytes` when it is
// not, for both matched lines and file paths.
type RgText = { text: string } | { bytes: string };

type RgMatchEvent = {
  type: "match";
  data: { path: RgText; line_number: number; lines: RgText };
};

export type GrepResult = {
  matches: { file: string; line: number; text: string }[];
  truncated: boolean;
};

// Reading `.text` unconditionally meant a single latin-1 line anywhere under the search
// path threw and discarded every match from every other file — the same "one problem loses
// the whole search" failure this tool exists to stop having.
function decodeRgText(value: RgText): string {
  return "text" in value ? value.text : Buffer.from(value.bytes, "base64").toString("utf8");
}

export function grep(pattern: string, opts: { path: string; glob?: string }): GrepResult {
  const args = ["--json"];
  if (opts.glob) args.push("-g", opts.glob);
  args.push(pattern, opts.path);

  const { stdout, truncated: overflowed } = runRipgrep(args);

  const lines = stdout.split("\n").filter(Boolean);
  // A full buffer cuts mid-event, so the trailing line is not parseable JSON.
  if (overflowed) lines.pop();

  const matches: GrepResult["matches"] = [];
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

  return { matches: matches.slice(0, MAX_RESULTS), truncated: overflowed || matches.length > MAX_RESULTS };
}
