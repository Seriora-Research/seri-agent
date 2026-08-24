// Code-block highlighting for `<markdown>` (app.tsx) — kept inside docs/design/tui.md's ANSI-16
// monochrome constraint by construction: every scope below is distinguished by weight
// (bold/dim/italic/underline), never by a color hue this file doesn't already share with theme.ts.
// Base scope names only ("keyword", not "keyword.conditional"): SyntaxStyle's own resolveStyleId
// (@opentui/core) falls back from a dotted scope to the text before its first dot, so registering
// the base name here already covers every subtype the bundled javascript/typescript/zig grammars'
// own highlights.scm files emit — confirmed directly against those files, not assumed from a
// grammar's general naming convention.
import { SyntaxStyle } from "@opentui/core";
import { theme } from "./theme";

export const syntaxStyle = SyntaxStyle.fromStyles({
  keyword: { bold: true },
  comment: { fg: theme.muted, dim: true },
  string: { italic: true },
  function: { underline: true },
  type: { italic: true, underline: true },
});
