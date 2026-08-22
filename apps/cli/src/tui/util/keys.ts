// Shared keyboard-decoding helpers for every `useKeyboard`/`usePaste` handler under tui/ —
// factored out after the same logic drifted into incompatible copies across components (a
// ConfirmPrompt that missed the "space" printable-key exception ApprovalBox/InputBox/ModelPicker
// already had, and a SetupList that read shortcut letters off `key.name` while its sibling
// ConfigList/PermissionsList read the identical shortcut off `key.sequence` — two different real
// keypresses silently doing different things depending on which panel happened to be open).

import type { KeyEvent } from "@opentui/core";

// OpenTUI reports Enter under three different `name`s depending on terminal/keyboard-protocol
// (`"return"` the common case, `"kpenter"` a numpad Enter, `"linefeed"` some terminals' Ctrl-J-as-
// Enter) — every call site needs all three or it silently drops one of them.
export function isEnter(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "kpenter" || key.name === "linefeed";
}

// A plain, printable keypress — the OpenTUI equivalent of Ink's `useInput` handing ordinary typed
// text through a pre-filtered `input` string; OpenTUI's `KeyEvent` carries no such field, so this
// reconstructs the same distinction. Every OpenTUI-parsed printable key's own `name` IS the
// literal character typed (`parse.keypress.js` sets `key.name = char`), with exactly one renamed
// exception — the space bar reports `name: "space"` even though it is printable — so
// `key.name.length === 1` (plus that one exception) is what a named/navigation key (`"up"`,
// `"pageup"`, `"escape"`, `"tab"`, every one of them multi-character) never satisfies. A Ctrl/Meta
// chord is excluded even when it otherwise looks single-character (e.g. Ctrl-A), and
// `key.sequence` — the real typed bytes/character, correct for non-ASCII input, not `key.name`'s
// normalised stand-in for cases like the space bar — is what a caller should append/compare.
export function isPrintableKey(key: KeyEvent): boolean {
  return (
    !key.ctrl &&
    !key.meta &&
    key.sequence.length > 0 &&
    (key.name.length === 1 || key.name === "space")
  );
}

// Escape or Ctrl-D, the shared "dismiss this panel entirely" chord every list-step panel
// (ModelPicker, SetupList, ConfigList, PermissionsList) treats identically — unlike the panels'
// OWN enter-key/value-entry steps, which split Escape (go back one step) and Ctrl-D (close
// outright) into two different actions, and so do not use this.
export function isDismiss(key: KeyEvent): boolean {
  return key.name === "escape" || (key.ctrl && key.name === "d");
}

// Splits pasted text at its first line terminator, treating a `\r\n` pair as ONE terminator (a
// Windows-clipboard paste is the common source of one) rather than two — stripping only the `\r`
// leaves a stray leading `\n` in `after`, requiring an extra, confusing Enter to clear what looked
// like a blank line. Returns null when the paste has no terminator at all, so a caller can tell
// "append the whole paste" apart from "submit `before`, carry `after` into the next input".
export function splitAtTerminator(text: string): { before: string; after: string } | null {
  const terminatorIndex = text.search(/[\r\n]/);
  if (terminatorIndex === -1) return null;
  const before = text.slice(0, terminatorIndex);
  const terminatorLength = text.startsWith("\r\n", terminatorIndex) ? 2 : 1;
  const after = text.slice(terminatorIndex + terminatorLength);
  return { before, after };
}
