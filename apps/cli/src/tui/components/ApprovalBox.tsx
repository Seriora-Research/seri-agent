/** @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { fileChangeFromTool } from "../../fileChange";
import type { ApprovalAnswer } from "../../loop/loop";
import { theme } from "../theme/theme";
import { OptionKeys } from "../ui/OptionKeys";
import { PanelBox } from "../ui/PanelBox";
import { approvalCopy, optionLabels } from "../util/approvalCopy";
import { isEnter, isPrintableKey } from "../util/keys";
import { FileChangeLines } from "./FileChangeLines";

export function ApprovalBox({
  pendingApproval,
  onAnswer,
  onQuit,
}: {
  pendingApproval: {
    toolName: string;
    args: unknown;
    offersAlways: boolean;
    classifierReason?: string;
  };
  onAnswer?: (answer: ApprovalAnswer) => void;
  onQuit?: () => void;
}) {
  const { toolName, args, offersAlways, classifierReason } = pendingApproval;
  const copy = approvalCopy(toolName, args, classifierReason);
  const preview = fileChangeFromTool(toolName, args, undefined, { maxLines: 8 });

  useKeyboard((key) => {
    if (key.ctrl && key.name === "d") {
      onQuit?.();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (isEnter(key)) {
      onAnswer?.("no");
      return;
    }
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
      {copy.classifierReason !== undefined && <text fg={theme.muted}>{copy.classifierReason}</text>}
      <text fg={theme.text}>{copy.question}</text>
      {copy.detail.length > 0 && <text fg={theme.muted}>{copy.detail}</text>}
      {preview !== undefined && <FileChangeLines change={preview} />}
      <OptionKeys labels={optionLabels(offersAlways)} />
    </PanelBox>
  );
}
