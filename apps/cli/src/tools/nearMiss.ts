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
// Stage 2 runs when no window qualified, and scores a single probe line by character similarity
// instead. Why it exists is argued at the branch itself.
//
// The two stages are floored DIFFERENTLY, and that asymmetry is the design rather than an
// oversight, because they rest on different kinds of evidence:
//
//   - Stage 1's evidence is POSITIONAL. The line it reports is corroborated by its neighbours
//     inside the window having matched. Character similarity is the wrong question to ask of it:
//     `stop();` vs `halt();` scores 0.429 as strings, but what makes it a near miss is that
//     `if (y) {` and `}` around it matched. Measured — flooring stage 1 on similarity rejected
//     that case and `log(err);` vs `report(err);` (0.500), both legitimate.
//   - Stage 2's evidence is ONLY the string. No neighbours, no corroboration, so a high character
//     floor is the entire thing keeping it honest.
//
// Pure, and deliberately so: it is called from `edit`, which takes the content as an argument and
// touches no disk (provider/tools.ts:106-114). At the failure site there is no path to read — the
// content came from the model's own tool-call arguments.

// Stage 2 only. See the asymmetry above for why stage 1 is not floored on this.
const MIN_SIMILARITY = 0.7;

// Whether a matched line is good enough evidence that THIS window is the right one. This is a
// solved problem in exactly this shape: it is the motivating example for **patience diff**, whose
// literature describes Myers diff aligning "any matching line, including very common ones, so
// moving a function in C can produce a noisy diff in which the closing brace of the moved function
// aligns with the closing brace of an unrelated function". That is our failure precisely.
//
// Patience's answer is UNIQUENESS — it anchors only on lines occurring exactly once — and both
// conditions below come from its own phrasing, "lines that are frequently non-unique, such as those
// containing a single brace":
//
//   1. Unique in the content. A line appearing many times is no evidence for any particular
//      window. This is the real rule, and it is the one a character test cannot express: `return;`
//      has identifiers and is worthless at 40 occurrences, while a `});` appearing exactly once is
//      genuinely informative.
//   2. Not punctuation-only. Uniqueness alone is not sufficient HERE, because patience compares two
//      files and needs a line unique in both, where we compare a short oldString against one file.
//      In small content the frequency statistic is meaningless — in the five-line case that
//      produced this bug, `}` occurs exactly once and would pass condition 1 on its own.
//
// Measured with condition 2 alone (a punctuation test, no uniqueness): a window anchored on a
// thrice-repeated `return;` reported `const a = 1;` as the near miss for
// `totallyDifferentThing();`. With condition 1 alone: the `});` repro returns.
function isUsableAnchor(trimmedLine: string, occurrences: number): boolean {
  return occurrences === 1 && /[A-Za-z0-9_]/.test(trimmedLine);
}

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

// Formatting only — each stage has already decided this pair is worth printing, by its own
// standard. Shared so the two reports cannot drift into different formats, NOT so they can share
// a quality bar; they do not have one.
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

  // Occurrence counts for the uniqueness half of `isUsableAnchor`. Built once rather than
  // re-counted per window: the scan is already O(windows * oldLines), and this keeps it there.
  const occurrences = new Map<string, number>();
  for (const line of contentLines) {
    const trimmed = line.trim();
    occurrences.set(trimmed, (occurrences.get(trimmed) ?? 0) + 1);
  }

  // Stage 1: the best window, where "best" is the most lines that trim-matched — but only among
  // windows that QUALIFY. Qualifying means at least one matching line is a usable anchor, and that
  // is the whole quality bar for this stage. It is applied at selection, not at report time, because
  // what can be wrong here is which window was chosen, never whether the line inside it is worth
  // naming: once neighbours have located the window, the first line that differs IS the answer.
  //
  // Measured before the qualification test existed: a three-line oldString whose only agreement
  // with the content was a closing brace selected that window and reported
  // `if (!token) return unauthorized();` as the near miss for
  // `const session = await loadSession(req);` — two unrelated lines asserted as a near miss.
  let bestStart = -1;
  let bestScore = 0;
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let score = 0;
    let qualifies = false;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== trimmedOld[j]) continue;
      score++;
      if (isUsableAnchor(trimmedOld[j], occurrences.get(trimmedOld[j]) ?? 0)) qualifies = true;
    }
    if (qualifies && score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  if (bestStart !== -1) {
    const differing = trimmedOld.findIndex((line, j) => contentLines[bestStart + j].trim() !== line);
    // Every line of the best window matched. Unreachable from `edit` — tier 1 would have replaced
    // it — but this is an exported pure function and "nothing differs" has no line to name.
    if (differing === -1) return null;
    return report(bestStart + differing, contentLines[bestStart + differing].trim(), trimmedOld[differing]);
  }

  // Stage 2, reached when no window qualified. Three shapes land here and stage 1 serves none of
  // them: a single-line oldString, which can never qualify (a content line that trim-matched it is
  // exactly what tier 1 replaces, so `edit` would not have reached this function); a multi-line
  // oldString where every line differs; and a window carried only by a trivial line. All three are
  // real, and a one-line edit is the most common shape there is.
  //
  // With no neighbours to corroborate it, the character floor below is the only evidence this
  // stage has, which is why it keeps one where stage 1 does not.
  const probe = trimmedOld.find((line) => line !== "");
  if (probe === undefined) return null;

  let bestIndex = -1;
  let bestSimilarity = 0;
  for (let i = 0; i < contentLines.length; i++) {
    const candidate = contentLines[i].trim();
    // An exact match is not a near miss, and naming one prints identical `actual` and `searched`
    // — the same symptom stage 1 exists to prevent, arriving from the other side. It bites when
    // oldString starts with `}`: the probe is `}`, some `}` in the file scores 1.0, and the report
    // points at a line the model got right.
    if (candidate === probe) continue;
    const score = similarity(candidate, probe);
    if (score > bestSimilarity) {
      bestSimilarity = score;
      bestIndex = i;
    }
  }

  if (bestIndex === -1 || bestSimilarity < MIN_SIMILARITY) return null;
  return report(bestIndex, contentLines[bestIndex].trim(), probe);
}
