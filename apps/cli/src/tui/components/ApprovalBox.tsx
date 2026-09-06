/** @jsxImportSource @opentui/react */
// Ported from panels/ApprovalBox.tsx: single-keypress y/a/n prompt, OpenTUI's element/hook names.

import { useKeyboard } from "@opentui/react";
import { fileChangeFromTool } from "../../fileChange";
import type { ApprovalAnswer } from "../../loop/loop";
import { theme } from "../theme/theme";
import { OptionKeys } from "../ui/OptionKeys";
import { PanelBox } from "../ui/PanelBox";
import { approvalCopy, optionLabels } from "../util/approvalCopy";
import { isEnter, isPrintableKey } from "../util/keys";
import { FileChangeLines } from "./FileChangeLines";

// TUI prose (approvalCopy), not approvalPromptText: the non-interactive CLI path stays a single
// JSON readline row. Captures a single keypress instead of readline's line-buffered question:
// y/a/n answer directly, Enter defaults to "no" (the bracketed capital in "[N]o"), and —
// matching the non-interactive path's own "anything unrecognised is 'no'" rule, applied
// per-keystroke here instead of per-line — so does everything else, except Ctrl-D (quits, see
// onQuit below) and a bare Ctrl/Meta chord otherwise (Ctrl-C included, which runtime/renderer.ts
// already routes to signals.ts; answering "no" here too would just be a redundant second
// resolution of the same promise, not incorrect, but not this component's concern either).
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
  const copy = approvalCopy(toolName, args);
  const preview = fileChangeFromTool(toolName, args, undefined, { maxLines: 8 });

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

  return (
    <PanelBox title="approve" right="">
      <text fg={theme.text}>{copy.question}</text>
      {copy.detail.length > 0 && <text fg={theme.muted}>{copy.detail}</text>}
      {preview !== undefined && <FileChangeLines change={preview} />}
      <OptionKeys labels={optionLabels(offersAlways)} />
    </PanelBox>
  );
}
