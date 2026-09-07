/** @jsxImportSource @opentui/react */
import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { useState } from "react";
import { useClipboardPaste } from "../../hooks/useClipboardPaste";
import { useListWindow } from "../../hooks/useListWindow";
import { type ConfigRow, configKeyInfo } from "../../state/commands";
import type { ConfigPanelState } from "../../state/reducer";
import { PanelBox } from "../../ui/PanelBox";
import { theme } from "../../theme/theme";
import { ConfirmPrompt } from "../../ui/ConfirmPrompt";
import { ErrorLine } from "../../ui/ErrorLine";
import { ListRow } from "../../ui/ListRow";
import { singleLine } from "../../util/format";
import { isDismiss, isEnter, isPrintableKey } from "../../util/keys";

export function ConfigPanel({
  pendingConfig,
  onConfigSelect,
  onConfigValueEntered,
  onConfigUnset,
  onConfigBack,
  onConfigClose,
}: {
  pendingConfig: ConfigPanelState;
  onConfigSelect?: (key: string) => void;
  onConfigValueEntered?: (key: string, value: string) => void;
  onConfigUnset?: (key: string) => void;
  onConfigBack?: () => void;
  onConfigClose?: (leftoverInput?: string) => void;
}) {
  if (pendingConfig.step === "enter-value") {
    return (
      <ConfigEnterValue
        pendingConfig={pendingConfig}
        onConfigValueEntered={onConfigValueEntered}
        onConfigBack={onConfigBack}
        onConfigClose={onConfigClose}
      />
    );
  }
  if (pendingConfig.step === "confirm-unset") {
    const { key } = pendingConfig;
    return (
      <ConfirmPrompt
        subject={`Unset ${configKeyInfo(key).label} (${key})`}
        onConfirm={() => onConfigUnset?.(key)}
        onCancel={() => onConfigBack?.()}
      />
    );
  }
  return (
    <ConfigList
      pendingConfig={pendingConfig}
      onConfigSelect={onConfigSelect}
      onConfigUnset={onConfigUnset}
      onConfigClose={onConfigClose}
    />
  );
}

function ConfigList({
  pendingConfig,
  onConfigSelect,
  onConfigUnset,
  onConfigClose,
}: {
  pendingConfig: Extract<ConfigPanelState, { step: "list" }>;
  onConfigSelect?: (key: string) => void;
  onConfigUnset?: (key: string) => void;
  onConfigClose?: (leftoverInput?: string) => void;
}) {
  const { rows } = pendingConfig;
  const { selected, visible, remainingCount, handleArrowKey } = useListWindow(
    rows,
    pendingConfig.selected,
  );

  useKeyboard((key) => {
    if (isDismiss(key)) {
      onConfigClose?.();
      return;
    }
    if (handleArrowKey(key)) return;
    const row = rows[selected];
    if (isEnter(key)) {
      if (row !== undefined) onConfigSelect?.(row.key);
      return;
    }
    if (key.name === "delete") {
      if (row?.removable) onConfigUnset?.(row.key);
      return;
    }
    if (!isPrintableKey(key)) return;
    if (row === undefined) return;
    const typed = key.sequence.toLowerCase();
    if (typed === "a") {
      onConfigSelect?.(row.key);
      return;
    }
    if (typed === "r" && row.removable) {
      onConfigUnset?.(row.key);
    }
  });

  const selectedRow = rows[selected];
  const actionHint = selectedRow?.kind === "boolean" ? "toggle" : "set";
  const selectedDescription =
    selectedRow === undefined ? undefined : configKeyInfo(selectedRow.key).description;

  return (
    <PanelBox title="/config — settings">
      {visible.map(({ row, isSelected }) => (
        <ListRow key={row.key} selected={isSelected} label={formatConfigRow(row)} />
      ))}
      {remainingCount > 0 && <text fg={theme.muted}>+{remainingCount} more</text>}
      {selectedDescription && (
        <text fg={theme.muted} truncate>
          {selectedDescription}
        </text>
      )}
      <text
        fg={theme.muted}
      >{`↑/↓ move · Enter/a ${actionHint} · r/Delete unset · Esc/Ctrl-D close`}</text>
    </PanelBox>
  );
}

function sourceTag(row: ConfigRow): string {
  if (row.source === "unset") return "";
  return row.source === "env" ? " (env)" : " (config)";
}

function formatConfigRow(row: ConfigRow): string {
  const label = configKeyInfo(row.key).label;
  if (row.kind === "boolean") return `${label}: ${row.on ? "on" : "off"}${sourceTag(row)}`;
  if (row.source === "unset") return `${label}: not set`;
  return `${label}: ${singleLine(row.masked)}${sourceTag(row)}`;
}

function ConfigEnterValue({
  pendingConfig,
  onConfigValueEntered,
  onConfigBack,
  onConfigClose,
}: {
  pendingConfig: Extract<ConfigPanelState, { step: "enter-value" }>;
  onConfigValueEntered?: (key: string, value: string) => void;
  onConfigBack?: () => void;
  onConfigClose?: (leftoverInput?: string) => void;
}) {
  const { key, error, busy } = pendingConfig;
  const [value, setValue] = useState("");
  const { label, description } = configKeyInfo(key);

  useKeyboard((inputKey) => {
    if (busy) return;
    if (inputKey.ctrl && inputKey.name === "d") {
      onConfigClose?.();
      return;
    }
    if (inputKey.name === "escape") {
      onConfigBack?.();
      return;
    }
    if (isEnter(inputKey)) {
      onConfigValueEntered?.(key, value);
      return;
    }
    if (inputKey.name === "backspace" || inputKey.name === "delete") {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (!isPrintableKey(inputKey)) return;
    setValue((current) => current + inputKey.sequence);
  });

  // OpenTUI delivers bracketed paste to usePaste, never useKeyboard.
  function insertPastedText(text: string) {
    if (busy) return;
    setValue((current) => current + text.replace(/[\r\n]/g, ""));
  }

  usePaste((event) => insertPastedText(decodePasteBytes(event.bytes)));

  useClipboardPaste(insertPastedText);

  return (
    <PanelBox title="/config">
      <text fg={theme.muted}>{`Set ${label} (${key})`}</text>
      <text fg={theme.muted}>{description}</text>
      <text>{"*".repeat(value.length)}</text>
      <ErrorLine message={error} />
      {busy ? (
        <text fg={theme.muted}>Saving…</text>
      ) : (
        <text fg={theme.muted}>Enter submit · Esc back · Ctrl-D close</text>
      )}
    </PanelBox>
  );
}
