export type Diagnostic = { file: string; line: number; column: number; message: string };



















const DIAGNOSTIC_LINE = /^(\S.*\.[A-Za-z0-9]+)\((\d+),(\d+)\): ((?:error|warning) TS\d+: .+)$/;




export function parseDiagnostics(text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];


  for (const raw of text.split("\n")) {
    // tsc emits CRLF on Windows; a trailing \r would fail the diagnostic regex.
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
