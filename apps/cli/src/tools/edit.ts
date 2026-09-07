import { describeNearMiss } from "./nearMiss";

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
    throw new Error(
      "oldString matched multiple times in content (exact match); cannot determine which occurrence to replace",
    );
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
      matches.push({
        start: lineStarts[i],
        end: lineStarts[lastLine] + contentLines[lastLine].length,
      });
    }
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      "oldString matched multiple times in content (line-trimmed match); cannot determine which occurrence to replace",
    );
  }
  return matches[0];
}

type WsRun = {
  origStart: number;
  origEnd: number;
  normPos: number;
};

function lastRunAtOrBefore(runs: readonly WsRun[], normIndex: number): WsRun | undefined {
  let lo = 0;
  let hi = runs.length - 1;
  let found: WsRun | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].normPos <= normIndex) {
      found = runs[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function origSpanForNormChar(runs: readonly WsRun[], normIndex: number): Span {
  const run = lastRunAtOrBefore(runs, normIndex);
  if (run === undefined) return { start: normIndex, end: normIndex + 1 };
  if (run.normPos === normIndex) return { start: run.origStart, end: run.origEnd };
  const orig = run.origEnd + (normIndex - run.normPos - 1);
  return { start: orig, end: orig + 1 };
}

function whitespaceRuns(content: string): WsRun[] {
  const runs: WsRun[] = [];
  let extra = 0;
  const wsRe = /\s+/g;
  let ws: RegExpExecArray | null;
  while ((ws = wsRe.exec(content)) !== null) {
    runs.push({
      origStart: ws.index,
      origEnd: ws.index + ws[0].length,
      normPos: ws.index - extra,
    });
    extra += ws[0].length - 1;
  }
  return runs;
}

function tryWhitespaceNormalizedMatch(content: string, oldString: string): Span | null {
  const normalizedContent = content.replace(/\s+/g, " ");
  const normalizedOld = oldString.replace(/\s+/g, " ");

  const matchStart = normalizedContent.indexOf(normalizedOld);
  if (matchStart === -1) return null;
  if (matchStart !== normalizedContent.lastIndexOf(normalizedOld)) {
    throw new Error(
      "oldString matched multiple times in content (whitespace-normalized match); cannot determine which occurrence to replace",
    );
  }

  const matchEnd = matchStart + normalizedOld.length;
  if (matchEnd === 0) return { start: 0, end: 0 };

  const runs = whitespaceRuns(content);
  return {
    start: origSpanForNormChar(runs, matchStart).start,
    end: origSpanForNormChar(runs, matchEnd - 1).end,
  };
}

export function edit(content: string, oldString: string, newString: string): string {
  const match =
    tryExactMatch(content, oldString) ??
    tryLineTrimmedMatch(content, oldString) ??
    tryWhitespaceNormalizedMatch(content, oldString);

  if (match === null) {
    const nearMiss = describeNearMiss(content, oldString);
    const base =
      "Could not find the specified text to replace (tried exact, line-trimmed, and whitespace-normalized matching)";
    throw new Error(nearMiss === null ? base : `${base}\n${nearMiss}`);
  }

  assertNotDisproportionate(oldString, match.end - match.start);

  return content.slice(0, match.start) + newString + content.slice(match.end);
}
