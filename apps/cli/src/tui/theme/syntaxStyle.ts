// Syntax highlighting for `<markdown>` (app.tsx) — kept inside docs/design/tui.md's ANSI-16
// monochrome constraint by construction: every scope below is distinguished by weight
// (bold/dim/italic/underline), never by a color hue this file doesn't already share with theme.ts.
//
// Two different registration shapes are needed below, both confirmed against @opentui/core's own
// SyntaxStyle.getStyleId (compiled chunk-bun-*.js): an unregistered scope falls back exactly once,
// from its full name to `name.split(".")[0]` — the text before its FIRST dot, never an intermediate
// parent.
// - Code scopes ("keyword", "string", ...): the bundled javascript/typescript/zig grammars only
//   ever emit single-level subtypes ("keyword.conditional"), so registering the base name alone
//   already covers every subtype those grammars' own highlights.scm files emit.
// - Prose scopes ("markup.*"): the bundled markdown/markdown_inline grammars' own highlights.scm
//   files emit multi-part scopes ("markup.heading.1", "markup.link.url") that all collapse to the
//   same top-level "markup" under that one-hop fallback, not to an intermediate "markup.heading" or
//   "markup.link" — so each prose category below is registered by its literal, full scope name
//   rather than a shared prefix.
import { SyntaxStyle } from "@opentui/core";
import { theme } from "./theme";

const heading = { bold: true, underline: true };
const link = { underline: true };
const muted = { fg: theme.muted, dim: true };

export const syntaxStyle = SyntaxStyle.fromStyles({
  keyword: { bold: true },
  comment: { fg: theme.muted, dim: true },
  string: { italic: true },
  function: { underline: true },
  type: { italic: true, underline: true },
  "markup.heading.1": heading,
  "markup.heading.2": heading,
  "markup.heading.3": heading,
  "markup.heading.4": heading,
  "markup.heading.5": heading,
  "markup.heading.6": heading,
  "markup.heading": heading,
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.link": link,
  "markup.link.url": link,
  "markup.link.label": link,
  "markup.list": muted,
  "markup.quote": muted,
});
