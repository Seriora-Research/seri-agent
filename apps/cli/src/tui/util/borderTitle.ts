// OpenTUI's box `title` is a single overlay on the top rule. Panels want the command on the
// left and `Esc` on the right of that same rule (docs/design/tui-mocks), which the renderer
// cannot express as two alignments, so the fill `─` lives inside the title string.

export function composeBorderTitle(title: string, right: string, columns: number): string {
  const inner = Math.max(0, columns - 2);
  const left = title.trim();
  const tail = right.trim();
  if (!tail) return left;
  if (!left) return tail;
  // OpenTUI paints one space on each side of the overlay, so those two columns are not
  // available for the fill.
  const used = left.length + 1 + 1 + tail.length + 2;
  const fill = Math.max(1, inner - used);
  return `${left} ${"─".repeat(fill)} ${tail}`;
}
