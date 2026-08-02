import { runRipgrep } from "./runRipgrep";

type RgMatchEvent = {
  type: "match";
  data: { path: { text: string }; line_number: number; lines: { text: string } };
};

export function grep(pattern: string, opts: { path: string; glob?: string }): { file: string; line: number; text: string }[] {
  const args = ["--json"];
  if (opts.glob) args.push("-g", opts.glob);
  args.push(pattern, opts.path);

  const stdout = runRipgrep(args);

  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string })
    .filter((event): event is RgMatchEvent => event.type === "match")
    .map((event) => ({
      file: event.data.path.text,
      line: event.data.line_number,
      text: event.data.lines.text.replace(/\r?\n$/, ""),
    }));
}
