const MIN_SIMILARITY = 0.7;

function isUsableAnchor(trimmedLine: string, occurrences: number): boolean {
  return occurrences === 1 && /[A-Za-z0-9_]/.test(trimmedLine);
}

function similarity(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  if (shorter === 0) return 0;

  let prefix = 0;
  while (prefix < shorter && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (suffix < shorter - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix])
    suffix++;

  return Math.min(prefix + suffix, shorter) / Math.max(a.length, b.length);
}

function report(lineIndex: number, actual: string, searched: string): string {
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

  const occurrences = new Map<string, number>();
  for (const line of contentLines) {
    const trimmed = line.trim();
    occurrences.set(trimmed, (occurrences.get(trimmed) ?? 0) + 1);
  }

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
    const differing = trimmedOld.findIndex(
      (line, j) => contentLines[bestStart + j].trim() !== line,
    );
    if (differing === -1) return null;
    return report(
      bestStart + differing,
      contentLines[bestStart + differing].trim(),
      trimmedOld[differing],
    );
  }

  const probe = trimmedOld.find((line) => line !== "");
  if (probe === undefined) return null;

  let bestIndex = -1;
  let bestSimilarity = 0;
  for (let i = 0; i < contentLines.length; i++) {
    const candidate = contentLines[i].trim();
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
