/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { theme } from "../theme/theme";
import { OptionKeys } from "./OptionKeys";
import { PanelBox } from "./PanelBox";
import { isEnter, isPrintableKey } from "../util/keys";

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
    if (isEnter(key)) {
      onCancel();
      return;
    }
    if (!isPrintableKey(key)) return;
    if (key.sequence.toLowerCase() === "y") {
      onConfirm();
      return;
    }
    onCancel();
  });
  return (
    <PanelBox title="confirm" right="">
      <text fg={theme.text}>{`${subject}?`}</text>
      <OptionKeys labels={["[y]es", "[N]o"]} />
    </PanelBox>
  );
}
