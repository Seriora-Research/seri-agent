// Extracted out of App.tsx (Stage A, cli-commands-to-tui feature-plan.md) verbatim: a pure move,
// no behavior change.

import type { ModelProvider } from "@seri/model-catalog";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { formatSetupRow } from "../format";
import type { SetupState } from "../reducer";
import { theme } from "../theme";
import { useListWindow } from "../useListWindow";

// /setup's own live state (tui/reducer.ts's pendingSetup) — mirrors ModelPicker's mutual-exclusion
// role, dispatching to one of three step-specific sub-components below rather than one component
// handling all three at once, since each step has genuinely different input handling and local
// state (the same reasoning ApprovalBox/ModelPicker are separate components rather than one
// component branching internally).
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
    return (
      <SetupConfirmRemove
        pendingSetup={pendingSetup}
        onSetupRemove={onSetupRemove}
        onSetupBack={onSetupBack}
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
  const [selected, setSelected] = useState(pendingSetup.selected);
  const { offset, windowSize, onSelectionMove } = useListWindow();

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "d")) {
      onSetupClose?.();
      return;
    }
    if (key.upArrow) {
      setSelected((current) => {
        const next = Math.max(0, current - 1);
        onSelectionMove(next);
        return next;
      });
      return;
    }
    if (key.downArrow) {
      setSelected((current) => {
        const next = Math.min(rows.length - 1, current + 1);
        onSelectionMove(next);
        return next;
      });
      return;
    }
    const row = rows[selected];
    // Bug fixed here (code-review, PR #73, round 3): `key.return`/`key.delete` must be checked
    // BEFORE the `input.length === 0` guard below, not after — Ink's own key parser sets `input`
    // to `''` for every named key, Enter and Delete included (confirmed against
    // node_modules/ink/build/parse-keypress.js and use-input.js), so the empty-input guard used to
    // return before either of these two branches was ever reached. Every other useInput in this
    // file (ModelPicker, SetupEnterKey, SetupConfirmRemove) already has the ordering this way —
    // this was the one holdout, and it made Enter/Delete dead here despite the panel's own hint
    // text advertising them.
    if (key.return) {
      if (row !== undefined) onSetupSelect?.(row.provider);
      return;
    }
    if (key.delete) {
      if (row !== undefined && row.removable) onSetupRemove?.(row.provider);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 0) return;
    if (row === undefined) return;
    const typed = input.toLowerCase();
    if (typed === "a") {
      onSetupSelect?.(row.provider);
      return;
    }
    if (typed === "r" && row.removable) {
      onSetupRemove?.(row.provider);
    }
  });

  const visible = rows.slice(offset, offset + windowSize);
  const remaining = rows.length - visible.length;

  return (
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
      <Text color={theme.muted}>/setup — provider API keys</Text>
      {visible.map((row, localIndex) => {
        const index = offset + localIndex;
        return (
          <Text key={row.provider} color={index === selected ? theme.accent : undefined}>
            {index === selected ? "> " : "  "}
            {formatSetupRow(row)}
          </Text>
        );
      })}
      {remaining > 0 && <Text color={theme.muted}>+{remaining} more</Text>}
      <Text color={theme.muted}>
        ↑/↓ move · Enter/a add or replace · r remove · Esc/Ctrl-D close
      </Text>
    </Box>
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

  useInput((input, key) => {
    if (busy) return;
    if (key.ctrl && input === "d") {
      onSetupClose?.();
      return;
    }
    if (key.escape) {
      onSetupBack?.();
      return;
    }
    if (key.return) {
      onSetupKeyEntered?.(provider, value);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 0) return;
    // A bare terminator embedded in a combined pty chunk (MEDIUM-E's own class, InputBox/
    // ModelPicker above) is not handled beyond stripping it — a pasted key is never expected to
    // contain a newline, and silently accepting one into a credential is worse than the rare
    // dropped keystroke this simplification could cost.
    setValue((current) => current + input.replace(/[\r\n]/g, ""));
  });

  return (
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
      <Text color={theme.muted}>{`${keyName} for ${provider}`}</Text>
      <Text>{"*".repeat(value.length)}</Text>
      {error !== undefined && <Text color={theme.error}>{error}</Text>}
      {busy ? (
        <Text color={theme.muted}>Validating…</Text>
      ) : (
        <Text color={theme.muted}>Enter submit · Esc back · Ctrl-D close</Text>
      )}
    </Box>
  );
}

function SetupConfirmRemove({
  pendingSetup,
  onSetupRemove,
  onSetupBack,
}: {
  pendingSetup: Extract<SetupState, { step: "confirm-remove" }>;
  onSetupRemove?: (provider: ModelProvider) => void;
  onSetupBack?: () => void;
}) {
  const { provider, keyName } = pendingSetup;

  useInput((input, key) => {
    // ApprovalBox's own convention (above): Enter and anything unrecognised both cancel — only an
    // explicit "y" confirms.
    if (key.return) {
      onSetupBack?.();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 0) return;
    if (input.toLowerCase() === "y") {
      onSetupRemove?.(provider);
      return;
    }
    onSetupBack?.();
  });

  return (
    <Box borderStyle="round" borderColor={theme.warning}>
      <Text color={theme.warning}>{`Remove ${keyName} (${provider})? [y]es / [N]o`}</Text>
    </Box>
  );
}
