import { describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { syntaxStyle } from "../../src/tui/theme/syntaxStyle";
import { theme } from "../../src/tui/theme/theme";

// Monochrome-compliance guard (docs/design/tui.md's ANSI-16-only constraint): every registered
// style's own `fg` must be either unset (default terminal color) or exactly `theme.muted` — the one
// existing token syntaxStyle.ts reuses — and `bg` must never be set at all, since no code-block style
// introduces a background color. A style carrying any OTHER color would be a new hue this migration
// was explicitly told not to introduce.
describe("syntaxStyle: monochrome compliance", () => {
  test("every registered style's own color is unset or theme.muted — never a new hue", () => {
    const mutedColor = parseColor(theme.muted);
    const styles = syntaxStyle.getAllStyles();
    expect(styles.size).toBeGreaterThan(0);

    for (const [name, style] of styles) {
      expect(style.bg, `${name}'s own bg`).toBeUndefined();
      if (style.fg !== undefined) {
        expect(style.fg.toString(), `${name}'s own fg`).toBe(mutedColor.toString());
      }
    }
  });

  // The weight-based distinctions (spec's own contract) are what actually differ between scopes,
  // not color — at least one registered style uses each of bold/dim/italic/underline, so the
  // "distinguished by weight, not hue" claim is backed by real registrations, not just the absence
  // of color.
  test("scopes are distinguished by bold/dim/italic/underline weight, not color", () => {
    const styles = [...syntaxStyle.getAllStyles().values()];
    expect(styles.some((s) => s.bold)).toBe(true);
    expect(styles.some((s) => s.dim)).toBe(true);
    expect(styles.some((s) => s.italic)).toBe(true);
    expect(styles.some((s) => s.underline)).toBe(true);
  });
});
