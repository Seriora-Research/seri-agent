// Structurally identical to panels/SetupPanel.tsx's own family (same step shape, same key
// bindings), adapted from arbitrary config.json keys/values rather than provider API keys.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { type ConfigRow, configKeyInfo } from "../commands";
import type { ConfigPanelState } from "../reducer";
import { theme } from "../theme";

// /config's own live state (tui/reducer.ts's pendingConfig) — mirrors SetupPanel's
// step-dispatcher exactly: one branch per step, since each has genuinely different input
// handling and local state.
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
    return (
      <ConfigConfirmUnset
        pendingConfig={pendingConfig}
        onConfigUnset={onConfigUnset}
        onConfigBack={onConfigBack}
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
  const [selected, setSelected] = useState(pendingConfig.selected);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "d")) {
      onConfigClose?.();
      return;
    }
    if (key.upArrow) {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((current) => Math.min(rows.length - 1, current + 1));
      return;
    }
    const row = rows[selected];
    // key.return/key.delete are checked before the input.length === 0 guard, matching
    // SetupList's own fix for this exact ordering (Ink reports input === '' for every named key).
    if (key.return) {
      if (row !== undefined) onConfigSelect?.(row.key);
      return;
    }
    if (key.delete) {
      if (row?.removable) onConfigUnset?.(row.key);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 0) return;
    if (row === undefined) return;
    const typed = input.toLowerCase();
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
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
      <Text color={theme.muted}>/config — settings</Text>
      {rows.map((row, index) => (
        <Text key={row.key} color={index === selected ? theme.accent : undefined}>
          {index === selected ? "> " : "  "}
          {formatConfigRow(row)}
        </Text>
      ))}
      {selectedDescription && <Text color={theme.muted}>{selectedDescription}</Text>}
      <Text
        color={theme.muted}
      >{`↑/↓ move · Enter/a ${actionHint} · r/Delete unset · Esc/Ctrl-D close`}</Text>
    </Box>
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
  return `${label}: ${row.masked}${sourceTag(row)}`;
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

  useInput((input, inputKey) => {
    if (busy) return;
    if (inputKey.ctrl && input === "d") {
      onConfigClose?.();
      return;
    }
    if (inputKey.escape) {
      onConfigBack?.();
      return;
    }
    if (inputKey.return) {
      onConfigValueEntered?.(key, value);
      return;
    }
    if (inputKey.backspace || inputKey.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (inputKey.ctrl || inputKey.meta) return;
    if (input.length === 0) return;
    setValue((current) => current + input.replace(/[\r\n]/g, ""));
  });

  return (
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
      <Text color={theme.muted}>{`Set ${label} (${key})`}</Text>
      <Text color={theme.muted}>{description}</Text>
      <Text>{"*".repeat(value.length)}</Text>
      {error !== undefined && <Text color={theme.error}>{error}</Text>}
      {busy ? (
        <Text color={theme.muted}>Saving…</Text>
      ) : (
        <Text color={theme.muted}>Enter submit · Esc back · Ctrl-D close</Text>
      )}
    </Box>
  );
}

function ConfigConfirmUnset({
  pendingConfig,
  onConfigUnset,
  onConfigBack,
}: {
  pendingConfig: Extract<ConfigPanelState, { step: "confirm-unset" }>;
  onConfigUnset?: (key: string) => void;
  onConfigBack?: () => void;
}) {
  const { key } = pendingConfig;
  const { label } = configKeyInfo(key);

  useInput((input, inputKey) => {
    // ApprovalBox's own convention: Enter and anything unrecognised both cancel — only an
    // explicit "y" confirms.
    if (inputKey.return) {
      onConfigBack?.();
      return;
    }
    if (inputKey.ctrl || inputKey.meta) return;
    if (input.length === 0) return;
    if (input.toLowerCase() === "y") {
      onConfigUnset?.(key);
      return;
    }
    onConfigBack?.();
  });

  return (
    <Box borderStyle="round" borderColor={theme.warning}>
      <Text color={theme.warning}>{`Unset ${label} (${key})? [y]es / [N]o`}</Text>
    </Box>
  );
}
