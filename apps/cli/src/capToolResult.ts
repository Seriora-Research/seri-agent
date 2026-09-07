export const MAX_TOOL_RESULT_CHARS = 30_000;
const HALF = MAX_TOOL_RESULT_CHARS / 2;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;

  let start = text.slice(0, HALF);
  let end = text.slice(-HALF);


  // A JS string is UTF-16; a cut between surrogate halves strands a replacement character.
  if (isHighSurrogate(start.charCodeAt(start.length - 1))) start = start.slice(0, -1);
  if (isLowSurrogate(end.charCodeAt(0))) end = end.slice(1);
  const omitted = text.length - start.length - end.length;
  return `${start}\n... [${omitted} characters omitted] ...\n${end}`;
}
