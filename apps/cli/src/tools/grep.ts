import { MAX_RESULTS, runRipgrep } from "./runRipgrep";

type RgMatchEvent = {
  type: "match";
  data: { path: { text: string }; line_number: number; lines: { text: string } };
};

export type GrepResult = {
  matches: { file: string; line: number; text: string }[];
  truncated: boolean;
};

export function grep(pattern: string, opts: { path: string; glob?: string }): GrepResult {
  const args = ["--json"];
  if (opts.glob) args.push("-g", opts.glob);
  args.push(pattern, opts.path);

  const { stdout, truncated: overflowed } = runRipgrep(args);

  const lines = stdout.split("\n").filter(Boolean);
  // A full buffer cuts mid-event, so the trailing line is not parseable JSON.
  if (overflowed) lines.pop();

  const matches = lines
    .map((line) => JSON.parse(line) as { type: string })
    .filter((event): event is RgMatchEvent => event.type === "match")
    .map((event) => ({
      file: event.data.path.text,
      line: event.data.line_number,
      text: event.data.lines.text.replace(/\r?\n$/, ""),
    }));

  return { matches: matches.slice(0, MAX_RESULTS), truncated: overflowed || matches.length > MAX_RESULTS };
}
