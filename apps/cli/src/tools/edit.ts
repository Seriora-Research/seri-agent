import { describeNearMiss } from "./nearMiss";

// Ratio is a judgment call: the source docs (docs/ARCHITECTURE.md) describe the
// disproportionate-match guard but don't specify an exact threshold. 5x trades off
// rejecting legitimate large replacements against accepting a match that grew far
// beyond oldString due to fuzzy (line-trim/whitespace-normalize) matching.
export const DISPROPORTIONATE_MATCH_RATIO = 5;

type Span = { start: number; end: number };

function assertNotDisproportionate(oldString: string, matchLength: number): void {
  if (matchLength > oldString.length * DISPROPORTIONATE_MATCH_RATIO) {
    throw new Error(
      `Matched span (${matchLength} chars) is disproportionately larger than the search text (${oldString.length} chars); refusing to replace`,
    );
  }
}

function tryExactMatch(content: string, oldString: string): Span | null {
  const start = content.indexOf(oldString);
  if (start === -1) return null;
  if (start !== content.lastIndexOf(oldString)) {
    throw new Error("oldString matched multiple times in content (exact match); cannot determine which occurrence to replace");
  }
  return { start, end: start + oldString.length };
}

function tryLineTrimmedMatch(content: string, oldString: string): Span | null {
  const contentLines = content.split("\n");
  const oldLines = oldString.split("\n");
  const trimmedOldLines = oldLines.map((line) => line.trim());

  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of contentLines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const matches: Span[] = [];
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let matched = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== trimmedOldLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const lastLine = i + oldLines.length - 1;
      matches.push({ start: lineStarts[i], end: lineStarts[lastLine] + contentLines[lastLine].length });
    }
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error("oldString matched multiple times in content (line-trimmed match); cannot determine which occurrence to replace");
  }
  return matches[0];
}

function tryWhitespaceNormalizedMatch(content: string, oldString: string): Span | null {
  // Build the normalized content alongside parallel arrays mapping each normalized
  // character back to the original [start, end) span in `content` it came from, so a
  // match found in normalized space can be mapped back to the original span.
  const normalizedChars: string[] = [];
  const normStart: number[] = [];
  const normEnd: number[] = [];

  let i = 0;
  while (i < content.length) {
    if (/\s/.test(content[i])) {
      let j = i;
      while (j < content.length && /\s/.test(content[j])) j++;
      normalizedChars.push(" ");
      normStart.push(i);
      normEnd.push(j);
      i = j;
    } else {
      normalizedChars.push(content[i]);
      normStart.push(i);
      normEnd.push(i + 1);
      i++;
    }
  }

  const normalizedContent = normalizedChars.join("");
  const normalizedOld = oldString.replace(/\s+/g, " ");

  const matchStart = normalizedContent.indexOf(normalizedOld);
  if (matchStart === -1) return null;
  if (matchStart !== normalizedContent.lastIndexOf(normalizedOld)) {
    throw new Error(
      "oldString matched multiple times in content (whitespace-normalized match); cannot determine which occurrence to replace",
    );
  }

  const matchEnd = matchStart + normalizedOld.length;
  return { start: normStart[matchStart], end: normEnd[matchEnd - 1] };
}

export function edit(content: string, oldString: string, newString: string): string {
  const match = tryExactMatch(content, oldString) ?? tryLineTrimmedMatch(content, oldString) ?? tryWhitespaceNormalizedMatch(content, oldString);

  if (match === null) {
    // The near-miss report is appended, never substituted: when no line is close enough
    // describeNearMiss returns null and the message is byte-identical to what it always was, so a
    // caller matching on the old wording (tests/tools/edit.test.ts) keeps matching.
    const nearMiss = describeNearMiss(content, oldString);
    const base = "Could not find the specified text to replace (tried exact, line-trimmed, and whitespace-normalized matching)";
    throw new Error(nearMiss === null ? base : `${base}\n${nearMiss}`);
  }

  assertNotDisproportionate(oldString, match.end - match.start);

  return content.slice(0, match.start) + newString + content.slice(match.end);
}
