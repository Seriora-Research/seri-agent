/** @jsxImportSource @opentui/react */
// No dispatcher wired to this yet — nothing dispatches permissions-requested/permissions-step/
// permissions-resolved. Only two steps, no value-entry step: there is nothing to type here, only
// tools to revoke.

import { useKeyboard } from "@opentui/react";
import { useListWindow } from "../../hooks/useListWindow";
import type { PermissionRow } from "../../state/commands";
import type { PermissionsPanelState } from "../../state/reducer";
import { theme } from "../../theme/theme";
import { ConfirmPrompt } from "../../ui/ConfirmPrompt";
import { ListRow } from "../../ui/ListRow";

// /permissions' own live state (state/reducer.ts's pendingPermissions) — mirrors SetupPanel's
// step-dispatcher shape with one fewer step; the confirm-remove step delegates to the shared
// ConfirmPrompt (ui/ConfirmPrompt.tsx) instead of a step-specific sub-component.
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
    if (key.name === "escape" || (key.ctrl && key.name === "d")) {
      onPermissionsClose?.();
      return;
    }
    if (handleArrowKey(key)) return;
    const row = rows[selected];
    if (key.name === "delete") {
      if (row?.removable) onPermissionsRemove?.(row.tool);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.sequence.length === 0 || (key.name.length !== 1 && key.name !== "space")) return;
    if (row === undefined) return;
    if (key.sequence.toLowerCase() === "r" && row.removable) {
      onPermissionsRemove?.(row.tool);
    }
  });

  return (
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.muted}>/permissions — tools approved permanently</text>
      {visible.map(({ row, isSelected }) => (
        <ListRow key={row.tool} selected={isSelected} label={formatPermissionRow(row)} />
      ))}
      {remainingCount > 0 && <text fg={theme.muted}>+{remainingCount} more</text>}
      <text fg={theme.muted}>↑/↓ move · r/Delete remove · Esc/Ctrl-D close</text>
    </box>
  );
}

function formatPermissionRow(row: PermissionRow): string {
  return row.removable
    ? `${row.tool} (${row.source})`
    : `${row.tool} (${row.source}, not removable)`;
}
