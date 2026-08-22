/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { WarningBox } from "./WarningBox";

// The shared y/N confirm step every SetupPanel/ConfigPanel/PermissionsPanel dispatcher uses:
// Enter and anything unrecognised both cancel, only an explicit "y" confirms. `key.ctrl || key.meta`
// and the `key.name.length !== 1` guard ahead of the "y" check are what makes an arrow key,
// Escape, Tab, or another named/navigation keypress a no-op here rather than falling through to
// the unrecognised-cancels branch and silently backing out of a destructive prompt — every OpenTUI
// KeyEvent for a plain printable character has a single-character `name` (e.g. "y"), while every
// named key ("return" aside, handled first) has a multi-character one ("escape", "up", "tab"...).
// This includes Escape: it is inert here, not a cancel shortcut, same as it was under Ink (whose
// own `useInput` stripped the ESC byte before this handler ever saw it).
//
// `subject` builds its own "? [y]es / [N]o" affordance rather than taking a pre-composed
// `message` — the same reasoning `approvalPromptText` (cli/output.ts) already states for why its
// prompt text is one function instead of written out at each call site: the text that promises
// "N cancels" and the code that implements it must not be free to drift apart across callers.
export function ConfirmPrompt({
  subject,
  onConfirm,
  onCancel,
}: {
  subject: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useKeyboard((key) => {
    if (key.name === "return") {
      onCancel();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.name.length !== 1) return;
    if (key.name.toLowerCase() === "y") {
      onConfirm();
      return;
    }
    onCancel();
  });
  return <WarningBox message={`${subject}? [y]es / [N]o`} />;
}
