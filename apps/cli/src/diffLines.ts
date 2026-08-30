const DIFF_CONTEXT = 2;

/**
 * Exact-prefix/exact-suffix trim, not a general LCS — enough for every diff this codebase previews,
 * and it needs no dependency. Shared by the two staged-write previews (memory entries and skill
 * files) so a human reviewing either reads the same shape of diff.
 *
 * Output lines are prefixed `- ` (removed), `+ ` (added) or two spaces (unchanged context).
 */
export function diffLines(before: string, after: string): string[] {
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

  const out: string[] = [];
  for (const line of beforeLines.slice(Math.max(0, prefix - DIFF_CONTEXT), prefix))
    out.push(`  ${line}`);
  for (const line of beforeLines.slice(prefix, beforeLines.length - suffix)) out.push(`- ${line}`);
  for (const line of afterLines.slice(prefix, afterLines.length - suffix)) out.push(`+ ${line}`);
  for (const line of afterLines.slice(
    afterLines.length - suffix,
    afterLines.length - suffix + DIFF_CONTEXT,
  )) {
    out.push(`  ${line}`);
  }
  return out;
}
