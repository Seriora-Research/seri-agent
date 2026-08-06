export type Diagnostic = { file: string; line: number; column: number; message: string };

// tsc's one-line diagnostic form: `path/to/file.ts(12,7): error TS2322: <message>`.
//
// The file group is required to end in an extension rather than being a bare `.+?`, and that is
// what makes the parser survive spawnCollect's middle-drop (spawnCollect.ts:80). The drop rejoins
// two halves of the stream, so the resumed half begins part-way through a line — `s(41,9): error
// TS2339: ...`. Under `.+?` that fragment parses as a diagnostic in a file called "s"; requiring an
// extension rejects it. Every path tsc prints has one, so nothing real is lost.
//
// The limit of that, stated because it is easy to over-read the line above: the fragment at the
// END of the first half is severed in its MESSAGE, not its path, so it still matches and yields a
// diagnostic whose message stops mid-sentence. Nothing in the line's shape can distinguish that
// from a genuinely short message. `truncated` is propagated to the model for exactly this reason
// — it is the only signal that what it is reading may be incomplete.
const DIAGNOSTIC_LINE = /^(\S.*\.[A-Za-z0-9]+)\((\d+),(\d+)\): ((?:error|warning) TS\d+: .+)$/;

// Anything that does not match is skipped, not fatal: a real run interleaves the package manager's
// own banner, blank lines, and a trailing "script exited with code 1", none of which are
// diagnostics and any of which would otherwise abort the parse of the ones that are.
export function parseDiagnostics(text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // \r is stripped rather than split on, because tsc emits CRLF on Windows and a trailing \r would
  // otherwise ride along inside the last capture group of every message.
  for (const raw of text.split("\n")) {
    const match = DIAGNOSTIC_LINE.exec(raw.replace(/\r$/, ""));
    if (match === null) continue;
    diagnostics.push({
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      message: match[4],
    });
  }
  return diagnostics;
}
