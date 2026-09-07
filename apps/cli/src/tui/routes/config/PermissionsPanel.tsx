/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useListWindow } from "../../hooks/useListWindow";
import type { PermissionRow } from "../../state/commands";
import type { PermissionsPanelState } from "../../state/reducer";
import { PanelBox } from "../../ui/PanelBox";
import { theme } from "../../theme/theme";
import { ConfirmPrompt } from "../../ui/ConfirmPrompt";
import { ListRow } from "../../ui/ListRow";
import { isDismiss, isPrintableKey } from "../../util/keys";

export function PermissionsPanel({
  pendingPermissions,
  onPermissionsRemove,
  onPermissionsBack,
  onPermissionsClose,
}: {
  pendingPermissions: PermissionsPanelState;
  onPermissionsRemove?: (tool: string) => void;
  onPermissionsBack?: () => void;
  onPermissionsClose?: (leftoverInput?: string) => void;
}) {
  if (pendingPermissions.step === "confirm-remove") {
    const { tool } = pendingPermissions;
    return (
      <ConfirmPrompt
        subject={`Remove ${tool}`}
        onConfirm={() => onPermissionsRemove?.(tool)}
        onCancel={() => onPermissionsBack?.()}
      />
    );
  }
  return (
    <PermissionsList
      pendingPermissions={pendingPermissions}
      onPermissionsRemove={onPermissionsRemove}
      onPermissionsClose={onPermissionsClose}
    />
  );
}

function PermissionsList({
  pendingPermissions,
  onPermissionsRemove,
  onPermissionsClose,
}: {
  pendingPermissions: Extract<PermissionsPanelState, { step: "list" }>;
  onPermissionsRemove?: (tool: string) => void;
  onPermissionsClose?: (leftoverInput?: string) => void;
}) {
  const { rows } = pendingPermissions;
  const { selected, visible, remainingCount, handleArrowKey } = useListWindow(
    rows,
    pendingPermissions.selected,
  );

  useKeyboard((key) => {
    if (isDismiss(key)) {
      onPermissionsClose?.();
      return;
    }
    if (handleArrowKey(key)) return;
    const row = rows[selected];
    if (key.name === "delete") {
      if (row?.removable) onPermissionsRemove?.(row.tool);
      return;
    }
    if (!isPrintableKey(key)) return;
    if (row === undefined) return;
    if (key.sequence.toLowerCase() === "r" && row.removable) {
      onPermissionsRemove?.(row.tool);
    }
  });

  return (
    <PanelBox title="/permissions — tools approved permanently">
      {visible.map(({ row, isSelected }) => (
        <ListRow key={row.tool} selected={isSelected} label={formatPermissionRow(row)} />
      ))}
      {remainingCount > 0 && <text fg={theme.muted}>+{remainingCount} more</text>}
      <text fg={theme.muted}>↑/↓ move · r/Delete remove · Esc/Ctrl-D close</text>
    </PanelBox>
  );
}

function formatPermissionRow(row: PermissionRow): string {
  return row.removable
    ? `${row.tool} (${row.source})`
    : `${row.tool} (${row.source}, not removable)`;
}
