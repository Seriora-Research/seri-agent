/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useListWindow } from "../../hooks/useListWindow";
import type { EffortPanelState } from "../../state/reducer";
import { PanelBox } from "../../ui/PanelBox";
import { theme } from "../../theme/theme";
import { ListRow } from "../../ui/ListRow";
import { isDismiss, isEnter } from "../../util/keys";

export function EffortPanel({
  pendingEffort,
  onEffortSelected,
  onEffortCancel,
}: {
  pendingEffort: EffortPanelState;
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
    <PanelBox title="/effort — reasoning effort for the current model">
      {visible.map(({ row, isSelected }) => (
        <ListRow key={row} selected={isSelected} label={row} />
      ))}
      {remainingCount > 0 && <text fg={theme.muted}>+{remainingCount} more</text>}
      <text fg={theme.muted}>↑/↓ move · Enter select · Esc/Ctrl-D cancel</text>
    </PanelBox>
  );
}
