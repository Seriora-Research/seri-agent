// Explains a failed `edit` in two stages, tried in this order and for different failures.
//
// Stage 1 reuses the cascade's OWN matching model: `tryLineTrimmedMatch` (edit.ts:28-60) slides a
// window of oldString's length over the content and requires EVERY line to trim-match, so the
// natural way to describe a near miss is the window where the most lines trim-matched, and the
// first line inside it that did not. This is what makes the report point at the right line.
// Scoring oldString's first line alone would report line 1 whenever the model got line 1 right —
// precisely the dominant case, since tier 1 already trim-matches every line, so a failure arriving
// here with a correct first line means a LATER line differs. Measured on an implementation that
// did that: for a four-line oldString differing only on line 2, it named line 1 and printed the
// same string as both `actual` and `searched`.
//
// Stage 2 runs ONLY when stage 1 found no window with even one matching line, and scores a single
// probe line by character similarity instead. It exists because two real shapes cannot score in a
// window at all — see the comment at that branch — and because being scoped to zero-score is what
// stops it from undoing stage 1.
//
// Pure, and deliberately so: it is called from `edit`, which takes the content as an argument and
// touches no disk (provider/tools.ts:98-106). At the failure site there is no path to read — the
// content came from the model's own tool-call arguments.

// Only used when NO window scored at all. Below this, no line is reported: without a floor the
// fallback would always name some line as "the closest", and a confident wrong answer is worse
// than the bare failure it replaces. It is also what stops a degenerate probe — a block whose
// first line is `}` — from scoring 1.0 against an arbitrary closing brace somewhere in the file.
const MIN_SIMILARITY = 0.7;

// Common prefix plus common suffix, over the longer line. Chosen over an edit distance because
// the failures it exists to explain are one substitution, one missing space, or a renamed
// identifier mid-line, and this scores all three high for one pass instead of an O(n*m) matrix per
// line. What it does NOT detect is a transposition spread across a whole line, which scores near
// zero and correctly reports nothing.
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

function report(lineIndex: number, actual: string, searched: string): string {
  // Both sides are shown TRIMMED, because trimming is exactly the comparison that rejected them.
  // Printing the raw lines would put an indentation difference in front of the model as though it
  // were the problem, when tier 1 has already ruled indentation out as a cause of failure.
  return [
    `Closest candidate is line ${lineIndex + 1} of the content:`,
    `  actual:   ${JSON.stringify(actual)}`,
    `  searched: ${JSON.stringify(searched)}`,
  ].join("\n");
}

export function describeNearMiss(content: string, oldString: string): string | null {
  const oldLines = oldString.split("\n");
  const contentLines = content.split("\n");
  if (oldLines.length > contentLines.length) return null;

  const trimmedOld = oldLines.map((line) => line.trim());

  // Stage 1: the best window, where "best" is the most lines that trim-matched. Starts at 0, so a
  // window is only chosen when at least ONE line matched — which is what keeps this stage from
  // inventing a "closest" out of a file with nothing relevant in it.
  let bestStart = -1;
  let bestScore = 0;
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let score = 0;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() === trimmedOld[j]) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  if (bestStart !== -1) {
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[bestStart + j].trim() === trimmedOld[j]) continue;
      return report(bestStart + j, contentLines[bestStart + j].trim(), trimmedOld[j]);
    }
    // Every line of the best window matched. Unreachable from `edit` — tier 1 would have replaced
    // it — but this is an exported pure function and "nothing differs" has no line to name.
    return null;
  }

  // Stage 2, reached ONLY when no window scored at all. Two shapes land here and window scoring
  // cannot serve either: a single-line oldString, which can never score (a content line that
  // trim-matched it is exactly what tier 1 replaces, so `edit` would not have reached this
  // function); and a multi-line oldString where every line differs. Both are real — a one-line
  // edit is the most common shape there is.
  //
  // Scoping it to score 0 is what keeps stage 1's fix intact. The failure this function exists to
  // get right — first line correct, a later line wrong — scores at least 1 and therefore never
  // reaches here, so the fallback cannot pull the report back onto the line the model got right.
  // And when nothing trim-matched anywhere, there is no such line to be misdirected toward.
  const probe = trimmedOld.find((line) => line !== "");
  if (probe === undefined) return null;

  let bestIndex = -1;
  let bestSimilarity = 0;
  for (let i = 0; i < contentLines.length; i++) {
    const score = similarity(contentLines[i].trim(), probe);
    if (score > bestSimilarity) {
      bestSimilarity = score;
      bestIndex = i;
    }
  }

  if (bestIndex === -1 || bestSimilarity < MIN_SIMILARITY) return null;
  return report(bestIndex, contentLines[bestIndex].trim(), probe);
}
