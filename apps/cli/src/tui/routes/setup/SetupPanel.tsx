/** @jsxImportSource @opentui/react */
// Ported from panels/SetupPanel.tsx: same logic, OpenTUI's element/hook names.

import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import type { ModelProvider } from "@seri/model-catalog";
import { useState } from "react";
import { useListWindow } from "../../hooks/useListWindow";
import type { SetupState } from "../../state/reducer";
import { theme } from "../../theme/theme";
import { ConfirmPrompt } from "../../ui/ConfirmPrompt";
import { ErrorLine } from "../../ui/ErrorLine";
import { ListRow } from "../../ui/ListRow";
import { formatSetupRow } from "../../util/format";
import { isEnter, isPrintableKey } from "../../util/keys";

// /setup's own live state (tui/state/reducer.ts's pendingSetup) — mirrors ModelPicker's mutual-
// exclusion role, dispatching to one of two step-specific sub-components below for the steps that
// still own input handling and local state (the same reasoning ApprovalBox/ModelPicker are
// separate components rather than one component branching internally); the confirm-remove step
// delegates to the shared ConfirmPrompt (ui/ConfirmPrompt.tsx) instead.
export function SetupPanel({
  pendingSetup,
  onSetupSelect,
  onSetupKeyEntered,
  onSetupRemove,
  onSetupBack,
  onSetupClose,
}: {
  pendingSetup: SetupState;
  onSetupSelect?: (provider: ModelProvider) => void;
  onSetupKeyEntered?: (provider: ModelProvider, value: string) => void;
  onSetupRemove?: (provider: ModelProvider) => void;
  onSetupBack?: () => void;
  onSetupClose?: (leftoverInput?: string) => void;
}) {
  if (pendingSetup.step === "enter-key") {
    return (
      <SetupEnterKey
        pendingSetup={pendingSetup}
        onSetupKeyEntered={onSetupKeyEntered}
        onSetupBack={onSetupBack}
        onSetupClose={onSetupClose}
      />
    );
  }
  if (pendingSetup.step === "confirm-remove") {
    const { provider, keyName } = pendingSetup;
    return (
      <ConfirmPrompt
        subject={`Remove ${keyName} (${provider})`}
        onConfirm={() => onSetupRemove?.(provider)}
        onCancel={() => onSetupBack?.()}
      />
    );
  }
  return (
    <SetupList
      pendingSetup={pendingSetup}
      onSetupSelect={onSetupSelect}
      onSetupRemove={onSetupRemove}
      onSetupClose={onSetupClose}
    />
  );
}

function SetupList({
  pendingSetup,
  onSetupSelect,
  onSetupRemove,
  onSetupClose,
}: {
  pendingSetup: Extract<SetupState, { step: "list" }>;
  onSetupSelect?: (provider: ModelProvider) => void;
  onSetupRemove?: (provider: ModelProvider) => void;
  onSetupClose?: (leftoverInput?: string) => void;
}) {
  const { rows } = pendingSetup;
  // Seeded from the reducer's own `selected` (set by whichever handler brought this step back into
  // view — cli.ts's own onSetupBack/onSetupKeyEntered), then moved locally — the same "reducer
  // supplies the starting point, the component owns live navigation" split ModelPicker's own
  // `selectedIndex` already has, for the identical reason (transient UI data with no reason to
  // round-trip through cli.ts on every arrow key).
  const { selected, visible, remainingCount, handleArrowKey } = useListWindow(
    rows,
    pendingSetup.selected,
  );

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "d")) {
      onSetupClose?.();
      return;
    }
    if (handleArrowKey(key)) return;
    const row = rows[selected];
    if (isEnter(key)) {
      if (row !== undefined) onSetupSelect?.(row.provider);
      return;
    }
    if (key.name === "delete") {
      if (row?.removable) onSetupRemove?.(row.provider);
      return;
    }
    if (!isPrintableKey(key)) return;
    if (row === undefined) return;
    const typed = key.sequence.toLowerCase();
    if (typed === "a") {
      onSetupSelect?.(row.provider);
      return;
    }
    if (typed === "r" && row.removable) {
      onSetupRemove?.(row.provider);
    }
  });

  return (
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.muted}>/setup — provider API keys</text>
      {visible.map(({ row, isSelected }) => (
        <ListRow key={row.provider} selected={isSelected} label={formatSetupRow(row)} />
      ))}
      {remainingCount > 0 && <text fg={theme.muted}>+{remainingCount} more</text>}
      <text fg={theme.muted}>↑/↓ move · Enter/a add or replace · r remove · Esc/Ctrl-D close</text>
    </box>
  );
}

function SetupEnterKey({
  pendingSetup,
  onSetupKeyEntered,
  onSetupBack,
  onSetupClose,
}: {
  pendingSetup: Extract<SetupState, { step: "enter-key" }>;
  onSetupKeyEntered?: (provider: ModelProvider, value: string) => void;
  onSetupBack?: () => void;
  onSetupClose?: (leftoverInput?: string) => void;
}) {
  const { provider, keyName, error, busy } = pendingSetup;
  // The real value lives here, never in anything rendered — the frame below only ever shows
  // `"*".repeat(value.length)`. This is the one piece of state in this whole file a leaked render
  // would turn into a credential disclosure, which is why it exists nowhere else: not in
  // `pendingSetup` (reducer state, visible to anything that reads it), not passed back to cli.ts
  // until the moment it actually submits.
  const [value, setValue] = useState("");

  useKeyboard((key) => {
    if (busy) return;
    if (key.ctrl && key.name === "d") {
      onSetupClose?.();
      return;
    }
    if (key.name === "escape") {
      onSetupBack?.();
      return;
    }
    if (isEnter(key)) {
      onSetupKeyEntered?.(provider, value);
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (!isPrintableKey(key)) return;
    setValue((current) => current + key.sequence);
  });

  // OpenTUI delivers a terminal paste as its own event (bracketed paste), never through
  // `useKeyboard` (InputBox.tsx's own comment) — under Ink this field's typed handler also
  // received a paste, which is why it stripped `\r\n` from whatever arrived; that stripping moves
  // here unchanged. Unlike InputBox/ModelPicker, this deliberately does NOT split on an embedded
  // terminator and auto-submit: a pasted key is never expected to contain a newline, and silently
  // accepting one into a credential is worse than the rare dropped keystroke this simplification
  // could cost (SetupEnterKey's original Ink-era comment, carried over unchanged).
  usePaste((event) => {
    if (busy) return;
    const text = decodePasteBytes(event.bytes);
    setValue((current) => current + text.replace(/[\r\n]/g, ""));
  });

  return (
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.muted}>{`${keyName} for ${provider}`}</text>
      <text>{"*".repeat(value.length)}</text>
      <ErrorLine message={error} />
      {busy ? (
        <text fg={theme.muted}>Validating…</text>
      ) : (
        <text fg={theme.muted}>Enter submit · Esc back · Ctrl-D close</text>
      )}
    </box>
  );
}
