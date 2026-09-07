import type { KeyEvent } from "@opentui/core";

// OpenTUI reports Enter as `return`, `kpenter`, or `linefeed` depending on terminal.
export function isEnter(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "kpenter" || key.name === "linefeed";
}

// OpenTUI has no pre-filtered input string; a printable `name` is the character, except space which is `name: "space"`.
export function isPrintableKey(key: KeyEvent): boolean {
  return (
    !key.ctrl &&
    !key.meta &&
    key.sequence.length > 0 &&
    (key.name.length === 1 || key.name === "space")
  );
}

export function isDismiss(key: KeyEvent): boolean {
  return key.name === "escape" || (key.ctrl && key.name === "d");
}

// Treat `\r\n` as one terminator so a Windows paste does not leave a stray `\n`.
export function splitAtTerminator(text: string): { before: string; after: string } | null {
  const terminatorIndex = text.search(/[\r\n]/);
  if (terminatorIndex === -1) return null;
  const before = text.slice(0, terminatorIndex);
  const terminatorLength = text.startsWith("\r\n", terminatorIndex) ? 2 : 1;
  const after = text.slice(terminatorIndex + terminatorLength);
  return { before, after };
}
