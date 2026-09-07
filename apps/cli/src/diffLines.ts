const DIFF_CONTEXT = 2;

export type UnifiedDiffKind = "context" | "add" | "del";

export type UnifiedDiffLine = {
  kind: UnifiedDiffKind;
  body: string;
  lineNumber: number;
};

const UNIFIED_MARK: Record<UnifiedDiffKind, string> = {
  context: "  ",
  add: "+ ",
  del: "- ",
};

/**
 * Exact-prefix/exact-suffix trim, not a general LCS — enough for every diff this codebase previews,
 * and it needs no dependency. Shared by the two staged-write previews (memory entries and skill
 * files) so a human reviewing either reads the same shape of diff.
 *
 * `lineNumber` is 1-based in the side that line came from: before-image for context-prefix and
 * dels, after-image for adds and context-suffix.
 */
export function diffLineEntries(before: string, after: string): UnifiedDiffLine[] {
  const beforeLines = before.length === 0 ? [] : before.split("\n");
  const afterLines = after.length === 0 ? [] : after.split("\n");

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: UnifiedDiffLine[] = [];
  for (let index = Math.max(0, prefix - DIFF_CONTEXT); index < prefix; index++) {
    const body = beforeLines[index];
    if (body === undefined) continue;
    out.push({ kind: "context", body, lineNumber: index + 1 });
  }
  for (let index = prefix; index < beforeLines.length - suffix; index++) {
    const body = beforeLines[index];
    if (body === undefined) continue;
    out.push({ kind: "del", body, lineNumber: index + 1 });
  }
  for (let index = prefix; index < afterLines.length - suffix; index++) {
    const body = afterLines[index];
    if (body === undefined) continue;
    out.push({ kind: "add", body, lineNumber: index + 1 });
  }
  const suffixStart = afterLines.length - suffix;
  const suffixEnd = Math.min(afterLines.length, suffixStart + DIFF_CONTEXT);
  for (let index = suffixStart; index < suffixEnd; index++) {
    const body = afterLines[index];
    if (body === undefined) continue;
    out.push({ kind: "context", body, lineNumber: index + 1 });
  }
  return out;
}

/**
 * Output lines are prefixed `- ` (removed), `+ ` (added) or two spaces (unchanged context).
 */
export function diffLines(before: string, after: string): string[] {
  return diffLineEntries(before, after).map((line) => `${UNIFIED_MARK[line.kind]}${line.body}`);
}
