/** @jsxImportSource @opentui/react */
// /effort's own live picker — a flat arrow-key list over the legal tiers
// for the model this session is CURRENTLY routed to (resolveLegalReasoningTiers, cli.ts's own
// onSubmit interception). Mirrors PermissionsPanel.tsx's own "list" step, one step simpler still:
// no confirm-remove, no value-entry — there is nothing here but a tier to pick or cancel out of.

import { useKeyboard } from "@opentui/react";
import { useListWindow } from "../../hooks/useListWindow";
import type { EffortPanelState } from "../../state/reducer";
import { theme } from "../../theme/theme";
import { ListRow } from "../../ui/ListRow";
import { isDismiss, isEnter } from "../../util/keys";

export function EffortPanel({
  pendingEffort,
  onEffortSelected,
  onEffortCancel,
}: {
  pendingEffort: EffortPanelState;
  // `leftoverInput`: threaded through, matching every other
  // panel's own `X-resolved` action shape, even though nothing in this component currently
  // produces a non-undefined value for it — EffortPanel has no text-entry/paste concept to capture
  // one from (mirrors PermissionsPanel's own onPermissionsClose, which carries the identical
  // optional param, structurally unused there too). Unlike PermissionsPanel's own call site (which
  // omits the argument entirely — `onPermissionsClose?.()`), the call sites below always pass
  // `undefined` explicitly, so the plumbing here reads as deliberate rather than as a forgotten
  // param.
  onEffortSelected?: (tier: string, leftoverInput?: string) => void;
  onEffortCancel?: (leftoverInput?: string) => void;
}) {
  const { tiers } = pendingEffort;
  const { selected, visible, remainingCount, handleArrowKey } = useListWindow(
    tiers,
    pendingEffort.selected,
  );

  useKeyboard((key) => {
    if (isDismiss(key)) {
      onEffortCancel?.(undefined);
      return;
    }
    if (handleArrowKey(key)) return;
    if (isEnter(key)) {
      const tier = tiers[selected];
      if (tier !== undefined) onEffortSelected?.(tier, undefined);
    }
  });

  return (
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.muted}>/effort — reasoning effort for the current model</text>
      {visible.map(({ row, isSelected }) => (
        <ListRow key={row} selected={isSelected} label={row} />
      ))}
      {remainingCount > 0 && <text fg={theme.muted}>+{remainingCount} more</text>}
      <text fg={theme.muted}>↑/↓ move · Enter select · Esc/Ctrl-D cancel</text>
    </box>
  );
}
