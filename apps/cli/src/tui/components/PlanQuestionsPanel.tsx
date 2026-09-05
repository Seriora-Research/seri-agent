/** @jsxImportSource @opentui/react */
import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { useState } from "react";
import { useClipboardPaste } from "../hooks/useClipboardPaste";
import type { PlanAnswers, PlanQuestion } from "../../plan/mode";
import { theme } from "../theme/theme";
import { ListRow } from "../ui/ListRow";
import { OptionKeys } from "../ui/OptionKeys";
import { PanelBox } from "../ui/PanelBox";
import { isEnter, isPrintableKey } from "../util/keys";

const CUSTOM_LABEL = "type your own";

export function PlanQuestionsPanel({
  questions,
  onAnswer,
  onQuit,
}: {
  questions: readonly PlanQuestion[];
  onAnswer?: (answers: PlanAnswers) => void;
  onQuit?: () => void;
}) {
  const tabCount = questions.length + 1;
  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState(() => questions.map(() => 0));
  const [custom, setCustom] = useState(() => questions.map(() => ""));
  const [notes, setNotes] = useState("");

  const onConfirm = tab === questions.length;
  const question = onConfirm ? undefined : questions[tab];

  function moveTab(delta: 1 | -1): void {
    setTab((current) => (current + delta + tabCount) % tabCount);
  }

  function choiceFor(index: number): string {
    const typed = custom[index]?.trim() ?? "";
    if (typed.length > 0) return typed;
    const q = questions[index];
    return q?.options[selected[index] ?? 0] ?? "";
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === "d") {
      onQuit?.();
      return;
    }
    if (key.name === "escape") {
      onAnswer?.({ cancelled: true });
      return;
    }
    if (key.name === "tab" || key.name === "left" || key.name === "right") {
      const backward = key.name === "left" || (key.name === "tab" && key.shift);
      moveTab(backward ? -1 : 1);
      return;
    }
    if (onConfirm) {
      if (isEnter(key)) {
        onAnswer?.({
          answers: questions.map((q, index) => ({ questionId: q.id, choice: choiceFor(index) })),
          notes: notes.trim().length > 0 ? notes.trim() : undefined,
        });
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        setNotes((current) => current.slice(0, -1));
        return;
      }
      if (!isPrintableKey(key)) return;
      setNotes((current) => current + key.sequence);
      return;
    }
    if (question === undefined) return;
    const optionCount = question.options.length + 1;
    if (key.name === "up" || key.name === "down") {
      const delta = key.name === "up" ? -1 : 1;
      setSelected((current) => {
        const next = [...current];
        const now = current[tab] ?? 0;
        next[tab] = (now + delta + optionCount) % optionCount;
        return next;
      });
      return;
    }
    if (isEnter(key)) {
      if (tab + 1 < tabCount) moveTab(1);
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      setCustom((current) => {
        const next = [...current];
        next[tab] = (current[tab] ?? "").slice(0, -1);
        return next;
      });
      setSelected((current) => {
        const next = [...current];
        next[tab] = optionCount - 1;
        return next;
      });
      return;
    }
    if (!isPrintableKey(key)) return;
    setCustom((current) => {
      const next = [...current];
      next[tab] = (current[tab] ?? "") + key.sequence;
      return next;
    });
    setSelected((current) => {
      const next = [...current];
      next[tab] = optionCount - 1;
      return next;
    });
  });

  function insertPastedText(text: string): void {
    const cleaned = text.replace(/[\r\n]/g, "");
    if (cleaned.length === 0) return;
    if (onConfirm) {
      setNotes((current) => current + cleaned);
      return;
    }
    setCustom((current) => {
      const next = [...current];
      next[tab] = (current[tab] ?? "") + cleaned;
      return next;
    });
    setSelected((current) => {
      const next = [...current];
      const optionCount = (questions[tab]?.options.length ?? 0) + 1;
      next[tab] = optionCount - 1;
      return next;
    });
  }

  usePaste((event) => insertPastedText(decodePasteBytes(event.bytes)));
  useClipboardPaste(insertPastedText);

  const tabLabels = [...questions.map((_, i) => `Q${i + 1}`), "notes"];

  return (
    <PanelBox title="plan questions" right="Esc cancel">
      <box flexDirection="row">
        {tabLabels.map((label, i) => (
          <text key={label} fg={i === tab ? theme.text : theme.muted} flexShrink={0}>
            {i === tab ? `[${label}]` : ` ${label} `}
            {i < tabLabels.length - 1 ? " " : ""}
          </text>
        ))}
      </box>
      {question !== undefined ? (
        <>
          <text fg={theme.text}>{question.prompt}</text>
          {question.options.map((option, i) => (
            <ListRow key={option} selected={(selected[tab] ?? 0) === i} label={option} />
          ))}
          <ListRow
            selected={(selected[tab] ?? 0) === question.options.length}
            label={
              (custom[tab] ?? "").length > 0
                ? `${CUSTOM_LABEL}: ${custom[tab]}`
                : CUSTOM_LABEL
            }
          />
        </>
      ) : (
        <>
          <text fg={theme.muted}>optional notes</text>
          <text fg={theme.text}>{notes.length > 0 ? notes : " "}</text>
        </>
      )}
      <OptionKeys
        labels={
          onConfirm
            ? ["Enter submit", "Tab switch", "Esc cancel"]
            : ["↑/↓ options", "type custom", "Enter next", "Tab switch", "Esc cancel"]
        }
      />
    </PanelBox>
  );
}
