// Below this, no line is reported at all. Without a floor the report would always name some line
// as "the closest", which is a confident wrong answer — worse than the bare failure it replaces,
// because the model would then edit the line it was pointed at.
const MIN_SIMILARITY = 0.7;

// Common prefix plus common suffix, over the longer line. Chosen over an edit distance because the
// failures this exists to explain are one substitution, one missing space, or a renamed identifier
// in the middle of an otherwise identical line, and this scores all three high while costing one
// pass instead of an O(n*m) matrix per line of the file. What it does NOT detect is a
// transposition spread across the whole line, which scores near zero and correctly reports nothing.
function similarity(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  if (shorter === 0) return 0;

  let prefix = 0;
  while (prefix < shorter && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (suffix < shorter - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  // Clamped at `shorter` so two identical lines score 1 rather than 2: prefix and suffix would
  // otherwise both count the whole line.
  return Math.min(prefix + suffix, shorter) / Math.max(a.length, b.length);
}

// Pure, and deliberately so: it is called from `edit`, which takes the content as an argument and
// touches no disk (provider/tools.ts:98-106). Nothing here may read a file, because at the failure
// site there is no path to read — the content came from the model's own tool-call arguments.
//
// Compares TRIMMED text, matching the cascade's own tier 1: a failure caused purely by indentation
// is already handled by line-trimmed matching, so a near miss that survived the cascade is a
// difference in the text itself and reporting the indentation as the difference would mislead.
export function describeNearMiss(content: string, oldString: string): string | null {
  const probe = oldString.split("\n").find((line) => line.trim() !== "")?.trim();
  if (probe === undefined) return null;

  const lines = content.split("\n");
  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const score = similarity(lines[i].trim(), probe);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex === -1 || bestScore < MIN_SIMILARITY) return null;

  return [
    `Closest candidate is line ${bestIndex + 1} of the content:`,
    `  actual:   ${JSON.stringify(lines[bestIndex])}`,
    `  searched: ${JSON.stringify(probe)}`,
  ].join("\n");
}
