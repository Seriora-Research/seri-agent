// Syntax highlighting for `<markdown>` (app.tsx) — kept inside docs/design/tui.md's ANSI-16
// monochrome constraint by construction: every scope below is distinguished by weight
// (bold/dim/italic/underline), never by a color hue this file doesn't already share with theme.ts.
//
// Two different registration shapes are needed below, both confirmed against @opentui/core's own
// SyntaxStyle.getStyleId (compiled chunk-bun-*.js): an unregistered scope falls back exactly once,
// from its full name to `name.split(".")[0]` — the text before its FIRST dot, whatever the scope's
// own depth (a two-level scope like TypeScript's `keyword.conditional.ternary` falls back to
// `keyword` the same as a one-level `keyword.conditional` would — the fallback doesn't care how
// many dots follow the first).
// - Code scopes ("keyword", "string", ...): registering the base name alone covers every subtype
//   the bundled javascript/typescript/zig grammars' own highlights.scm files emit for it, however
//   deep, via that one-hop fallback.
// - Prose scopes ("markup.*"): the bundled markdown/markdown_inline grammars' own highlights.scm
//   files emit multi-part scopes ("markup.heading.1", "markup.list.checked") that all collapse to
//   the same top-level "markup" under that one-hop fallback, not to an intermediate "markup.heading"
//   or "markup.list" — so each prose category actually used needs its own literal, full scope name
//   registered rather than a shared prefix. `syntaxStyle.test.ts`'s own grammar-coverage test derives
//   the full scope list straight from the vendored `highlights.scm` files and asserts every one of
//   them either resolves here or is named in that test's own deliberately-unstyled allowlist, so a
//   scope this file misses (prose or code) fails loudly instead of silently rendering as plain text.
import { SyntaxStyle } from "@opentui/core";
import { theme } from "./theme";

const heading = { bold: true, underline: true };
const link = { underline: true };
const muted = { fg: theme.muted, dim: true };

export const syntaxStyle = SyntaxStyle.fromStyles({
  keyword: { bold: true },
  comment: muted,
  string: { italic: true },
  function: { underline: true },
  type: { italic: true, underline: true },
  // Literal-value categories, checked against the bundled javascript/typescript/zig grammars'
  // own highlights.scm files (`node_modules/@opentui/core/assets/*/highlights.scm`) the same way
  // as the five scopes above — `constant` (registering the base name alone also covers its own
  // `constant.builtin` subtype, e.g. JS/TS's `true`/`false`/`null`/`undefined`, per this file's own
  // one-hop-fallback design for code scopes) and `boolean` (TypeScript/Zig only; JS has no
  // dedicated boolean scope, its literals fall under `constant.builtin` instead).
  number: { bold: true, dim: true },
  constant: { underline: true, dim: true },
  boolean: { underline: true, dim: true },
  "markup.heading.1": heading,
  "markup.heading.2": heading,
  "markup.heading.3": heading,
  "markup.heading.4": heading,
  "markup.heading.5": heading,
  "markup.heading.6": heading,
  "markup.heading": heading,
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.strikethrough": { dim: true },
  "markup.raw": muted,
  "markup.raw.block": muted,
  "markup.link": link,
  "markup.link.url": link,
  "markup.link.label": link,
  "markup.list": muted,
  "markup.list.checked": muted,
  "markup.list.unchecked": muted,
  "markup.quote": muted,
});
