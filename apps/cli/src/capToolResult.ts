export const MAX_TOOL_RESULT_CHARS = 30_000;
const HALF = MAX_TOOL_RESULT_CHARS / 2;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function capFromBoundedWindows(start: string, end: string, totalUtf16Units: number): string {
  let head = start.slice(0, HALF);
  let tail = end.slice(-HALF);

  // A JS string is UTF-16; a cut between surrogate halves strands a replacement character.
  if (isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
  if (isLowSurrogate(tail.charCodeAt(0))) tail = tail.slice(1);
  const omitted = totalUtf16Units - head.length - tail.length;
  return `${head}\n... [${omitted} characters omitted] ...\n${tail}`;
}

export function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return capFromBoundedWindows(text, text, text.length);
}
