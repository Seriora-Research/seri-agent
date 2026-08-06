// Explains a failed `edit` by reusing the cascade's OWN matching model rather than a second,
// bespoke one: `tryLineTrimmedMatch` (edit.ts:28-60) slides a window of oldString's length over the
// content and requires EVERY line to trim-match, so the natural way to describe a near miss is the
// window that came closest — the one where the most lines trim-matched — and the first line inside
// it that did not.
//
// That framing is what makes the report point at the right line. Scoring the first line of
// oldString alone reports line 1 whenever the model got line 1 right, which is precisely the
// dominant case: because tier 1 already trim-matches every line, a failure that reaches here with a
// correct first line means a LATER line differs. Measured on the previous implementation, for a
// four-line oldString differing only on line 2, the report named line 1 and printed the same string
// as both `actual` and `searched`.
//
// Pure, and deliberately so: it is called from `edit`, which takes the content as an argument and
// touches no disk (provider/tools.ts:98-106). At the failure site there is no path to read — the
// content came from the model's own tool-call arguments.
export function describeNearMiss(content: string, oldString: string): string | null {
  const oldLines = oldString.split("\n");
  const contentLines = content.split("\n");
  if (oldLines.length > contentLines.length) return null;

  const trimmedOld = oldLines.map((line) => line.trim());

  // Starts at 0, so a window is only ever chosen if at least ONE line trim-matched. That is the
  // whole threshold, and it is what stops the report inventing a "closest" line out of a file with
  // nothing relevant in it — a confident wrong answer is worse than the bare failure it replaces.
  //
  // The consequence, stated because it is a real narrowing and not an oversight: a SINGLE-line
  // oldString can never score 1 here. If one content line trim-matched it, tier 1 would have
  // replaced it (or thrown "matched multiple times"), so `edit` would never have reached this
  // function. Single-line near misses therefore report nothing and the message stays bare.
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

  if (bestStart === -1) return null;

  for (let j = 0; j < oldLines.length; j++) {
    if (contentLines[bestStart + j].trim() === trimmedOld[j]) continue;
    // Both sides are shown TRIMMED, because trimming is exactly the comparison that rejected them.
    // Printing the raw lines would put an indentation difference in front of the model as though it
    // were the problem, when tier 1 has already ruled indentation out as a cause of failure.
    return [
      `Closest candidate is line ${bestStart + j + 1} of the content:`,
      `  actual:   ${JSON.stringify(contentLines[bestStart + j].trim())}`,
      `  searched: ${JSON.stringify(trimmedOld[j])}`,
    ].join("\n");
  }

  // Every line of the best window matched. Unreachable from `edit` — tier 1 would have replaced it
  // — but this is an exported pure function and "nothing differs" has no line to name.
  return null;
}
