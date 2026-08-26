import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// docs/design/tui.md: `ink-soft` (== theme.muted, "gray") IS the single diluted tone — "ink and
// paper themselves, just diluted". A scope that sets it must NOT also set `dim`, which applies a
// second dilution on top of the first and drops inline code, fenced blocks, paths, list markers
// and quotes below readable contrast against the theme.text prose they sit in. `dim` on its own
// is still a legitimate weight — number/constant/boolean/markup.strikethrough all use it with no
// `fg` — so what this guards is specifically the two stacked on one style, not `dim` itself.
// Derived, not hand-maintained (same reasoning as the grammar-coverage test below): every scope
// whose own `fg` is theme.muted is in scope here, so a future scope added to the shared `muted`
// object is covered automatically instead of silently missing from a hand-copied list.
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

// The markdown/markdown_inline grammars' own highlights.scm files (not the code grammars) emit
// these exact "markup.*" scopes for bold text, headings, italics, links, list markers, and
// blockquotes — asserted by resolveStyleId so a future edit that renames/removes one of these
// literal keys (rather than relying on the base-scope fallback the code scopes use) fails loudly.
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

// The javascript/typescript/zig grammars' own highlights.scm files emit `number`/`constant`/
// `boolean` with no registered style covering them until this literal-value coverage was added — a
// plain `<markdown>` code block would otherwise render every number/constant/boolean token
// completely unstyled, the same as ordinary prose around it.
describe("syntaxStyle: code literal-value scopes resolve", () => {
  test.each(["number", "constant", "boolean"])("%s resolves to a registered style", (scope) => {
    expect(syntaxStyle.resolveStyleId(scope)).not.toBeNull();
  });

  // `constant.builtin` (JS/TS's `true`/`false`/`null`/`undefined`) is a single-level subtype with
  // no literal registration of its own — covered only via `getStyleId`'s one-hop fallback to
  // `constant` (this file's own header comment), NOT via `resolveStyleId`'s exact-match lookup the
  // tests above use, so this one has to go through the actual fallback method to mean anything.
  test("constant.builtin falls back to the registered constant style via getStyleId", () => {
    expect(syntaxStyle.resolveStyleId("constant.builtin")).toBeNull();
    expect(syntaxStyle.getStyleId("constant.builtin")).not.toBeNull();
    expect(syntaxStyle.getStyleId("constant.builtin")).toBe(syntaxStyle.resolveStyleId("constant"));
  });
});

// Deliberately left unstyled: identifiers/punctuation/structural scopes a minimal monochrome theme
// leaves plain by design (the keyword/comment/string/type/function/literal-value categories in
// syntaxStyle.ts are the ones worth visually distinguishing — styling every token defeats the point
// of highlighting). Each entry is either a bare base scope (covers every `base.*` subtype via the
// same one-hop fallback `getStyleId` itself uses) or one exact full scope name for a multi-part
// scope with no useful base — this list is an allowlist of gaps, not a duplicate of syntaxStyle.ts's
// own registrations. The coverage test below only fails when a grammar scope resolves to NEITHER a
// real style NOR this allowlist — a grammar bump that renames one of these entries onto a base that
// IS registered (e.g. `variable` becoming `constant`) would make that scope pass silently there;
// "still unresolved" is checked separately, explicitly, right below.
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

// The allowlist's own converse: every entry above must actually still be unresolved, so a grammar
// rename that moves one onto a now-registered base (e.g. a future `variable` → `constant`) fails
// here instead of just silently dropping out of the coverage test below.
describe("syntaxStyle: deliberately-unstyled allowlist stays accurate", () => {
  test.each([...DELIBERATELY_UNSTYLED])(
    "%s is still an unresolved gap, not accidentally covered",
    (scope) => {
      expect(syntaxStyle.getStyleId(scope)).toBeNull();
    },
  );
});

// Derived, not hand-maintained: reads every scope the 5 bundled grammars' own `highlights.scm`
// files actually emit (the same files syntaxStyle.ts's own header comment cites) and asserts each
// one either resolves through `getStyleId` (exact match or one-hop base fallback — the real
// resolution path `<markdown>`'s renderer uses, not just `resolveStyleId`'s narrower exact lookup)
// or is named above as an intentional gap. A hand-maintained list of "scopes I checked" — the shape
// the two `describe` blocks above use — silently misses a scope nobody thought to add; this doesn't,
// because it starts from the grammar files themselves rather than from memory of what they contain.
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
