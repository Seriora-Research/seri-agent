// OpenTUI's box title is one overlay and cannot align left and right, so the fill `─` lives in the title string.
export function composeBorderTitle(title: string, right: string, columns: number): string {
  const inner = Math.max(0, columns - 2);
  const left = title.trim();
  const tail = right.trim();
  if (!tail) return left;
  if (!left) return tail;
  // OpenTUI paints one space on each side of the title overlay.
  const used = left.length + 1 + 1 + tail.length + 2;
  const fill = Math.max(1, inner - used);
  return `${left} ${"─".repeat(fill)} ${tail}`;
}
