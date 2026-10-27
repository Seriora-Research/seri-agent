export const MAX_TOOL_RESULT_CHARS = 30_000;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function omissionMarker(omitted: number): string {
  return `\n... [${omitted} characters omitted] ...\n`;
}

export function capFromBoundedWindows(
  start: string,
  end: string,
  totalUtf16Units: number,
  maxChars = MAX_TOOL_RESULT_CHARS,
): string {
  const half = Math.floor(maxChars / 2);
  // slice(-0) is slice(0), the whole string, so a zero window is the marker alone.
  if (half <= 0) return omissionMarker(totalUtf16Units);
  let head = start.slice(0, half);
  let tail = end.slice(-half);

  // A JS string is UTF-16; a cut between surrogate halves strands a replacement character.
  if (head.length > 0 && isHighSurrogate(head.charCodeAt(head.length - 1)))
    head = head.slice(0, -1);
  if (tail.length > 0 && isLowSurrogate(tail.charCodeAt(0))) tail = tail.slice(1);
  const omitted = totalUtf16Units - head.length - tail.length;
  return `${head}${omissionMarker(omitted)}${tail}`;
}

export function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return capFromBoundedWindows(text, text, text.length);
}
