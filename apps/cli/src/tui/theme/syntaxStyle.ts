// OpenTUI SyntaxStyle.getStyleId falls back once to the token before the first dot, so code scopes
// register the base name and markup scopes need each full name.
import { SyntaxStyle } from "@opentui/core";
import { theme } from "./theme";

const heading = { bold: true, underline: true };
const link = { underline: true };
const muted = { fg: theme.muted };
const code = { fg: theme.code };

export const syntaxStyle = SyntaxStyle.fromStyles({
  keyword: { bold: true },
  comment: muted,
  string: { italic: true },
  function: { underline: true },
  type: { italic: true, underline: true },
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
  "markup.raw": code,
  "markup.raw.block": code,
  "markup.link": link,
  "markup.link.url": link,
  "markup.link.label": link,
  "markup.list": muted,
  "markup.list.checked": muted,
  "markup.list.unchecked": muted,
  "markup.quote": muted,
});
