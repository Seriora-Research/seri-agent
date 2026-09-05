/** @jsxImportSource @opentui/react */

import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { useState } from "react";
import type { AskPrompt, HumanReply } from "../../ask-user/types";
import { useClipboardPaste } from "../hooks/useClipboardPaste";
import { theme } from "../theme/theme";
import { ListRow } from "../ui/ListRow";
import { OptionKeys } from "../ui/OptionKeys";
import { PanelBox } from "../ui/PanelBox";
import { isEnter, isPrintableKey } from "../util/keys";

const OTHER_LABEL = "type your own";

export function AskUserPanel({
  prompt,
  onAnswer,
  onQuit,
}: {
  prompt: AskPrompt;
  onAnswer?: (reply: HumanReply) => void;
  onQuit?: () => void;
}) {
  const optionCount = prompt.choices.length + (prompt.allowOther ? 1 : 0);
  const otherIndex = prompt.allowOther ? prompt.choices.length : -1;
  const [selected, setSelected] = useState(0);
  const [custom, setCustom] = useState("");

  function submitCurrent(): void {
    if (selected === otherIndex) {
      const text = custom.trim();
      if (text.length === 0) return;
      onAnswer?.({ outcome: "other", text });
      return;
    }
    const choice = prompt.choices[selected];
    if (choice === undefined) return;
    onAnswer?.({ outcome: "picked", choice });
  }

  function typeIntoOther(next: string): void {
    if (!prompt.allowOther) return;
    setCustom(next);
    setSelected(otherIndex);
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === "d") {
      onQuit?.();
      return;
    }
    if (key.name === "escape") {
      onAnswer?.({ outcome: "cancelled" });
      return;
    }
    if (key.name === "up" || key.name === "down") {
      const delta = key.name === "up" ? -1 : 1;
      setSelected((current) => (current + delta + optionCount) % optionCount);
      return;
    }
    if (isEnter(key)) {
      submitCurrent();
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      typeIntoOther(custom.slice(0, -1));
      return;
    }
    if (!isPrintableKey(key)) return;
    typeIntoOther(custom + key.sequence);
  });

  function insertPastedText(text: string): void {
    const cleaned = text.replace(/[\r\n]/g, "");
    if (cleaned.length === 0) return;
    typeIntoOther(custom + cleaned);
  }

  usePaste((event) => insertPastedText(decodePasteBytes(event.bytes)));
  useClipboardPaste(insertPastedText);

  return (
    <PanelBox title="question" right="Esc cancel">
      <text fg={theme.text}>{prompt.prompt}</text>
      {prompt.choices.map((choice, i) => (
        <ListRow key={choice} selected={selected === i} label={choice} />
      ))}
      {prompt.allowOther ? (
        <ListRow
          selected={selected === otherIndex}
          label={custom.length > 0 ? `${OTHER_LABEL}: ${custom}` : OTHER_LABEL}
        />
      ) : null}
      <OptionKeys
        labels={
          prompt.allowOther
            ? ["↑/↓ options", "type custom", "Enter submit", "Esc cancel"]
            : ["↑/↓ options", "Enter submit", "Esc cancel"]
        }
      />
    </PanelBox>
  );
}
