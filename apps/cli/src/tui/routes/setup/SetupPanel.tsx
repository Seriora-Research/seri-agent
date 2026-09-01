/** @jsxImportSource @opentui/react */
// Ported from panels/SetupPanel.tsx: same logic, OpenTUI's element/hook names.

import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import type { ModelProvider } from "@seri/model-catalog";
import { useState } from "react";
import { GROK_BORROWED_CLIENT_WARNING } from "../../../auth/xaiConnect";
import { useClipboardPaste } from "../../hooks/useClipboardPaste";
import { useListWindow } from "../../hooks/useListWindow";
import type {
  SetupGrokSubscriptionRow,
  SetupProviderRow,
  SetupSubscriptionRow,
} from "../../state/commands";
import { isSetupActionRow, setupRowId } from "../../state/commands";
import type { SetupState } from "../../state/reducer";
import { FRAME } from "../../theme/spacing";
import { theme } from "../../theme/theme";
import { ConfirmPrompt } from "../../ui/ConfirmPrompt";
import { ErrorLine } from "../../ui/ErrorLine";
import { ListRow } from "../../ui/ListRow";
import { formatSetupRow } from "../../util/format";
import { isDismiss, isEnter, isPrintableKey } from "../../util/keys";

const SUBSCRIPTION_ROW: SetupGrokSubscriptionRow = {
  kind: "subscription",
  provider: "xai",
  connected: false,
};

function subscriptionDisconnectable(row: SetupSubscriptionRow): boolean {
  return row.provider === "xai" ? row.connected : row.status.status === "connected";
}

export function SetupPanel({
  pendingSetup,
  onSetupSelect,
  onSetupKeyEntered,
  onSetupRemove,
  onSetupBack,
  onSetupClose,
}: {
  pendingSetup: SetupState;
  onSetupSelect?: (row: SetupProviderRow) => void;
  onSetupKeyEntered?: (provider: ModelProvider, value: string) => void;
  onSetupRemove?: (row: SetupProviderRow) => void;
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
        onConfirm={() =>
          onSetupRemove?.({
            kind: "key",
            provider,
            keyName,
            source: "config",
            masked: undefined,
            removable: true,
          })
        }
        onCancel={() => onSetupBack?.()}
      />
    );
  }
  if (pendingSetup.step === "confirm-connect") {
    if (pendingSetup.provider === "openai") {
      return (
        <ConfirmPrompt
          subject="Re-enable ChatGPT plan via Codex (login is already present; this only clears the local ignore)"
          onConfirm={() =>
            onSetupRemove?.({
              kind: "subscription",
              provider: "openai",
              status: { status: "ignored" },
              removable: false,
            })
          }
          onCancel={() => onSetupBack?.()}
        />
      );
    }
    return (
      <SetupConnectWarning
        onConfirm={() => onSetupRemove?.(SUBSCRIPTION_ROW)}
        onCancel={() => onSetupBack?.()}
      />
    );
  }
  if (pendingSetup.step === "confirm-disconnect") {
    const openai = pendingSetup.provider === "openai";
    return (
      <ConfirmPrompt
        subject={
          openai
            ? "Disconnect ChatGPT plan (local ignore only; Codex CLI login is not revoked)"
            : "Disconnect Grok subscription (local credential only; xAI access is not revoked)"
        }
        onConfirm={() =>
          onSetupRemove?.(
            openai
              ? {
                  kind: "subscription",
                  provider: "openai",
                  status: { status: "connected" },
                  removable: true,
                }
              : { ...SUBSCRIPTION_ROW, connected: true },
          )
        }
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

function SetupConnectWarning({
  onConfirm,
  onCancel,
}: {
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
    <box {...FRAME} flexDirection="column" borderColor={theme.warning}>
      <text fg={theme.warning}>{GROK_BORROWED_CLIENT_WARNING}</text>
      <text fg={theme.muted}>Shown before the browser opens. [y]es connect / [N]o cancel</text>
    </box>
  );
}

function SetupList({
  pendingSetup,
  onSetupSelect,
  onSetupRemove,
  onSetupClose,
}: {
  pendingSetup: Extract<SetupState, { step: "list" }>;
  onSetupSelect?: (row: SetupProviderRow) => void;
  onSetupRemove?: (row: SetupProviderRow) => void;
  onSetupClose?: (leftoverInput?: string) => void;
}) {
  const { rows } = pendingSetup;
  const { selected, visible, remainingCount, handleArrowKey } = useListWindow(
    rows,
    pendingSetup.selected,
  );

  useKeyboard((key) => {
    if (isDismiss(key)) {
      onSetupClose?.();
      return;
    }
    if (handleArrowKey(key)) return;
    const row = rows[selected];
    if (row === undefined || !isSetupActionRow(row)) return;
    if (isEnter(key)) {
      onSetupSelect?.(row);
      return;
    }
    if (key.name === "delete") {
      if (row.kind === "key" && row.removable) onSetupRemove?.(row);
      if (row.kind === "subscription" && subscriptionDisconnectable(row)) {
        onSetupSelect?.(row);
      }
      return;
    }
    if (!isPrintableKey(key)) return;
    const typed = key.sequence.toLowerCase();
    if (typed === "a") {
      onSetupSelect?.(row);
      return;
    }
    if (typed === "r") {
      if (row.kind === "key" && row.removable) onSetupRemove?.(row);
      if (row.kind === "subscription" && subscriptionDisconnectable(row)) {
        onSetupSelect?.(row);
      }
    }
  });

  const selectedRow = rows[selected];
  const hint =
    selectedRow?.kind === "subscription"
      ? selectedRow.provider === "xai"
        ? selectedRow.connected
          ? "↑/↓ move · Enter/r disconnect · Esc/Ctrl-D close"
          : "↑/↓ move · Enter connect · Esc/Ctrl-D close"
        : selectedRow.status.status === "connected"
          ? "↑/↓ move · Enter/r disconnect · Esc/Ctrl-D close"
          : selectedRow.status.status === "ignored"
            ? "↑/↓ move · Enter re-enable · Esc/Ctrl-D close"
            : "↑/↓ move · Enter show Codex setup · Esc/Ctrl-D close"
      : "↑/↓ move · Enter/a add or replace · r remove · Esc/Ctrl-D close";

  return (
    <box {...FRAME} flexDirection="column">
      <text fg={theme.muted}>/setup — provider API keys</text>
      {visible.map(({ row, isSelected }) =>
        row.kind === "heading" ? (
          <text key={setupRowId(row)} fg={theme.muted}>
            {row.label}
          </text>
        ) : (
          <ListRow key={setupRowId(row)} selected={isSelected} label={formatSetupRow(row)} />
        ),
      )}
      {remainingCount > 0 && <text fg={theme.muted}>+{remainingCount} more</text>}
      <text fg={theme.muted}>{hint}</text>
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
  function insertPastedText(text: string) {
    if (busy) return;
    setValue((current) => current + text.replace(/[\r\n]/g, ""));
  }

  usePaste((event) => insertPastedText(decodePasteBytes(event.bytes)));

  // Ctrl-V, which no terminal turns into the paste event above — see the hook's own comment. Shares
  // `insertPastedText` so a key pasted either way is stripped of newlines the same.
  useClipboardPaste(insertPastedText);

  return (
    <box {...FRAME} flexDirection="column">
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
