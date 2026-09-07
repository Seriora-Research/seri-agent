import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseColor } from "@opentui/core";
import { syntaxStyle } from "../../src/tui/theme/syntaxStyle";
import { theme } from "../../src/tui/theme/theme";

describe("syntaxStyle: monochrome compliance", () => {
  test("every registered style's own color is unset, theme.muted, or theme.code — never a new hue", () => {
    const mutedColor = parseColor(theme.muted);
    const codeColor = parseColor(theme.code);
    const styles = syntaxStyle.getAllStyles();
    expect(styles.size).toBeGreaterThan(0);

    for (const [name, style] of styles) {
      expect(style.bg, `${name}'s own bg`).toBeUndefined();
      if (style.fg !== undefined) {
        expect([mutedColor.toString(), codeColor.toString()], `${name}'s own fg`).toContain(
          style.fg.toString(),
        );
      }
    }
  });

  test("scopes are distinguished by bold/dim/italic/underline weight, not color", () => {
    const styles = [...syntaxStyle.getAllStyles().values()];
    expect(styles.some((s) => s.bold)).toBe(true);
    expect(styles.some((s) => s.dim)).toBe(true);
    expect(styles.some((s) => s.italic)).toBe(true);
    expect(styles.some((s) => s.underline)).toBe(true);
  });
});

describe("syntaxStyle: ink-soft scopes dilute once, not twice", () => {
  const mutedColor = parseColor(theme.muted).toString();
  const mutedScopes = [...syntaxStyle.getAllStyles()]
    .filter(([, style]) => style.fg?.toString() === mutedColor)
    .map(([name]) => name);

  test("at least one scope uses theme.muted", () => {
    expect(mutedScopes.length).toBeGreaterThan(0);
  });

  test.each(mutedScopes)("%s uses theme.muted with no second dim pass", (scope) => {
    const style = syntaxStyle.getStyle(scope);
    expect(style?.fg?.toString(), `${scope}'s own fg`).toBe(mutedColor);
    expect(style?.dim, `${scope} stacks dim on top of theme.muted`).toBeUndefined();
  });
});

describe("syntaxStyle: markdown prose scopes resolve", () => {
  test.each([
    "markup.heading.1",
    "markup.heading.2",
    "markup.heading.3",
    "markup.heading.4",
    "markup.heading.5",
    "markup.heading.6",
    "markup.heading",
    "markup.strong",
    "markup.italic",
    "markup.link",
    "markup.link.url",
    "markup.link.label",
    "markup.list",
    "markup.list.checked",
    "markup.list.unchecked",
    "markup.quote",
    "markup.strikethrough",
    "markup.raw",
    "markup.raw.block",
  ])("%s resolves to a registered style", (scope) => {
    expect(syntaxStyle.resolveStyleId(scope)).not.toBeNull();
  });

  test("markup.heading and markup.strong are both bold, but only markup.heading is underlined", () => {
    const heading = syntaxStyle.getStyle("markup.heading.1");
    const strong = syntaxStyle.getStyle("markup.strong");
    expect(heading?.bold).toBe(true);
    expect(heading?.underline).toBe(true);
    expect(strong?.bold).toBe(true);
    expect(strong?.underline).toBeUndefined();
  });
});

describe("syntaxStyle: code literal-value scopes resolve", () => {
  test.each(["number", "constant", "boolean"])("%s resolves to a registered style", (scope) => {
    expect(syntaxStyle.resolveStyleId(scope)).not.toBeNull();
  });

  test("constant.builtin falls back to the registered constant style via getStyleId", () => {
    expect(syntaxStyle.resolveStyleId("constant.builtin")).toBeNull();
    expect(syntaxStyle.getStyleId("constant.builtin")).not.toBeNull();
    expect(syntaxStyle.getStyleId("constant.builtin")).toBe(syntaxStyle.resolveStyleId("constant"));
  });
});

const DELIBERATELY_UNSTYLED = new Set([
  "variable",
  "operator",
  "punctuation",
  "property",
  "constructor",
  "attribute",
  "label",
  "module",
  "character",
  "embedded",
  "none",
  "spell",
  "nospell",
  "conceal",
  "cImport",
  "import",
  "markup.link.bracket.close",
]);

describe("syntaxStyle: deliberately-unstyled allowlist stays accurate", () => {
  test.each([...DELIBERATELY_UNSTYLED])(
    "%s is still an unresolved gap, not accidentally covered",
    (scope) => {
      expect(syntaxStyle.getStyleId(scope)).toBeNull();
    },
  );
});

// Coverage is derived from the five bundled grammars' highlights.scm, not a hand-copied list.
describe("syntaxStyle: full grammar scope coverage", () => {
  const grammarDir = join(import.meta.dir, "../../node_modules/@opentui/core/assets");

  for (const grammar of readdirSync(grammarDir)) {
    const scm = readFileSync(join(grammarDir, grammar, "highlights.scm"), "utf8");
    const scopes = [...new Set([...scm.matchAll(/@([a-zA-Z0-9_.]+)/g)].map((m) => m[1] as string))];

    test.each(scopes)(`${grammar}: %s resolves or is a known, deliberate gap`, (scope) => {
      if (syntaxStyle.getStyleId(scope) !== null) return;
      const base = scope.split(".")[0];
      expect(
        DELIBERATELY_UNSTYLED.has(scope) || DELIBERATELY_UNSTYLED.has(base),
        `"${scope}" is unresolved and not in DELIBERATELY_UNSTYLED — register it in syntaxStyle.ts, or add it there if the gap is intentional`,
      ).toBe(true);
    });
  }
});
