/** @jsxImportSource @opentui/react */
// Ported from panels/ApprovalBox.tsx: single-keypress y/a/n prompt, OpenTUI's element/hook names.

import { useKeyboard } from "@opentui/react";
import { approvalPromptText } from "../../cli/output";
import type { ApprovalAnswer } from "../../loop/loop";
import { WarningBox } from "../ui/WarningBox";
import { isEnter, isPrintableKey } from "../util/keys";

// approvalPromptText (cli/output.ts), not a hand-copied template: same escaping, same
// PERSISTABLE_TOOLS-gated "always" option, same [N]o-is-the-default framing as the non-interactive
// path's own rl.question call (cli.ts), from one shared function, so switching between the two
// can't drift apart. Captures a single keypress instead of readline's line-buffered question: y/a/n
// answer directly, Enter defaults to "no" (the bracketed capital in "[N]o"), and — matching the
// non-interactive path's own "anything unrecognised is 'no'" rule, applied per-keystroke here
// instead of per-line — so does everything else, except Ctrl-D (quits, see onQuit below) and a
// bare Ctrl/Meta chord otherwise (Ctrl-C included, which runtime/renderer.ts already routes to
// signals.ts; answering "no" here too would just be a redundant second resolution of the
// same promise, not incorrect, but not this component's concern either).
export function ApprovalBox({
  pendingApproval,
  onAnswer,
  onQuit,
}: {
  pendingApproval: { toolName: string; args: unknown; offersAlways: boolean };
  onAnswer?: (answer: ApprovalAnswer) => void;
  onQuit?: () => void;
}) {
  const { toolName, args, offersAlways } = pendingApproval;

  useKeyboard((key) => {
    // Ctrl-D used to do nothing while this component was mounted instead of InputBox — quit()
    // itself (cli.ts) denies the pending approval as part of the same graceful sequence before
    // proceeding, so this is the same onQuit InputBox's own Ctrl-D calls, not a separate "deny
    // just this one prompt" path.
    if (key.ctrl && key.name === "d") {
      onQuit?.();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (isEnter(key)) {
      onAnswer?.("no");
      return;
    }
    // An arrow key, Backspace, Tab, Escape, or any other non-printable key must not fall into the
    // "anything unrecognised is 'no'" catch-all below, meant for actual mistyped TEXT — a stray
    // navigation keypress would otherwise silently deny the approval.
    if (!isPrintableKey(key)) return;
    const typed = key.sequence.toLowerCase();
    if (typed === "y") {
      onAnswer?.("once");
      return;
    }
    if (offersAlways && typed === "a") {
      onAnswer?.("always");
      return;
    }
    onAnswer?.("no");
  });

  return <WarningBox message={approvalPromptText(toolName, args, offersAlways)} />;
}
