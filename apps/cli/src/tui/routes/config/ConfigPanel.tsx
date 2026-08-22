/** @jsxImportSource @opentui/react */
// Structurally identical to routes/setup/SetupPanel.tsx's own family (same step shape, same key
// bindings), adapted from arbitrary config.json keys/values rather than provider API keys.

import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { useState } from "react";
import { useListWindow } from "../../hooks/useListWindow";
import { type ConfigRow, configKeyInfo } from "../../state/commands";
import type { ConfigPanelState } from "../../state/reducer";
import { theme } from "../../theme/theme";
import { ConfirmPrompt } from "../../ui/ConfirmPrompt";
import { ErrorLine } from "../../ui/ErrorLine";
import { ListRow } from "../../ui/ListRow";
import { singleLine } from "../../util/format";
import { isEnter, isPrintableKey } from "../../util/keys";

// /config's own live state (state/reducer.ts's pendingConfig) — mirrors SetupPanel's
// step-dispatcher shape: one branch per step that still owns input handling and local state;
// the confirm-unset step delegates to the shared ConfirmPrompt (ui/ConfirmPrompt.tsx) instead.
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
  // Seeded from the reducer's own `selected`, then moved locally — SetupList's own split between
  // "reducer supplies the starting point, the component owns live navigation".
  const { selected, visible, remainingCount, handleArrowKey } = useListWindow(
    rows,
    pendingConfig.selected,
  );

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "d")) {
      onConfigClose?.();
      return;
    }
    if (handleArrowKey(key)) return;
    const row = rows[selected];
    // "return"/"delete" are checked before the printable-key guard below: `isPrintableKey` excludes
    // named keys like these, so checking them AFTER the guard would let it silently return before
    // their own branch ever ran.
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
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.muted}>/config — settings</text>
      {visible.map(({ row, isSelected }) => (
        <ListRow key={row.key} selected={isSelected} label={formatConfigRow(row)} />
      ))}
      {remainingCount > 0 && <text fg={theme.muted}>+{remainingCount} more</text>}
      {selectedDescription && (
        // Same reasoning as ListRow's own comment (ui/ListRow.tsx): a config key's own description
        // is fixed copy today (state/commands.ts trims it to fit an assumed 80-column terminal),
        // but nothing here reads the REAL terminal width, so a narrower real TTY reproduces the
        // exact overflow that fix closed for the default width only. Truncating is the one
        // guarantee that holds at any width.
        <text fg={theme.muted} truncate>
          {selectedDescription}
        </text>
      )}
      <text
        fg={theme.muted}
      >{`↑/↓ move · Enter/a ${actionHint} · r/Delete unset · Esc/Ctrl-D close`}</text>
    </box>
  );
}

// Total over ConfigRow["source"], so both branches below share one definition instead of one
// calling this and the other re-inlining a near-twin ternary that has to be kept in sync by hand.
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
  // Never rendered raw — the same credential-disclosure reasoning SetupEnterKey's own `value`
  // has: any config value could be secret-shaped, so this always renders `"*".repeat(...)`.
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

  // OpenTUI delivers a terminal paste as its own event, never through `useKeyboard` — see
  // components/InputBox.tsx's own comment. A pasted config value (an API key is the common case)
  // is appended the same way typed text is, newlines stripped; unlike InputBox/ModelPicker, a
  // paste here never submits on a terminator — this step only ever submits on Enter.
  usePaste((event) => {
    if (busy) return;
    const text = decodePasteBytes(event.bytes).replace(/[\r\n]/g, "");
    setValue((current) => current + text);
  });

  return (
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.muted}>{`Set ${label} (${key})`}</text>
      <text fg={theme.muted}>{description}</text>
      <text>{"*".repeat(value.length)}</text>
      <ErrorLine message={error} />
      {busy ? (
        <text fg={theme.muted}>Saving…</text>
      ) : (
        <text fg={theme.muted}>Enter submit · Esc back · Ctrl-D close</text>
      )}
    </box>
  );
}
