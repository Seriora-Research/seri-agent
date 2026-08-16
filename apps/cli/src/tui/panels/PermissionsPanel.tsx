// Stage A scaffolding (cli-commands-to-tui feature-plan.md): no dispatcher wired to this yet —
// Stage D wires /permissions to fire `permissions-requested`/`permissions-step`/
// `permissions-resolved`. New code, not a move. Only two steps, no value-entry step: there is
// nothing to type here, only tools to revoke.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { PermissionRow } from "../commands";
import type { PermissionsPanelState } from "../reducer";
import { theme } from "../theme";
import { useListWindow } from "../useListWindow";

// /permissions' own live state (tui/reducer.ts's pendingPermissions) — mirrors SetupPanel's
// step-dispatcher shape with one fewer step.
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
    return (
      <PermissionsConfirmRemove
        pendingPermissions={pendingPermissions}
        onPermissionsRemove={onPermissionsRemove}
        onPermissionsBack={onPermissionsBack}
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
  const [selected, setSelected] = useState(pendingPermissions.selected);
  const { offset, windowSize, onSelectionMove } = useListWindow(pendingPermissions.selected);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "d")) {
      onPermissionsClose?.();
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
    if (key.delete) {
      if (row?.removable) onPermissionsRemove?.(row.tool);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 0) return;
    if (row === undefined) return;
    if (input.toLowerCase() === "r" && row.removable) {
      onPermissionsRemove?.(row.tool);
    }
  });

  const visible = rows.slice(offset, offset + windowSize);
  // Rows strictly BELOW the window, not `rows.length - visible.length` (which counts rows hidden
  // above the window too, and stays flat at `rows.length - windowSize` the whole time the window
  // is full — the footer would never count down while scrolling toward the bottom).
  const remaining = Math.max(0, rows.length - offset - windowSize);

  return (
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
      <Text color={theme.muted}>/permissions — tools approved permanently</Text>
      {visible.map((row, localIndex) => {
        const index = offset + localIndex;
        return (
          <Text key={row.tool} color={index === selected ? theme.accent : undefined}>
            {index === selected ? "> " : "  "}
            {formatPermissionRow(row)}
          </Text>
        );
      })}
      {remaining > 0 && <Text color={theme.muted}>+{remaining} more</Text>}
      <Text color={theme.muted}>↑/↓ move · r/Delete remove · Esc/Ctrl-D close</Text>
    </Box>
  );
}

function formatPermissionRow(row: PermissionRow): string {
  return row.removable
    ? `${row.tool} (${row.source})`
    : `${row.tool} (${row.source}, not removable)`;
}

function PermissionsConfirmRemove({
  pendingPermissions,
  onPermissionsRemove,
  onPermissionsBack,
}: {
  pendingPermissions: Extract<PermissionsPanelState, { step: "confirm-remove" }>;
  onPermissionsRemove?: (tool: string) => void;
  onPermissionsBack?: () => void;
}) {
  const { tool } = pendingPermissions;

  useInput((input, key) => {
    // ApprovalBox's own convention: Enter and anything unrecognised both cancel — only an
    // explicit "y" confirms.
    if (key.return) {
      onPermissionsBack?.();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 0) return;
    if (input.toLowerCase() === "y") {
      onPermissionsRemove?.(tool);
      return;
    }
    onPermissionsBack?.();
  });

  return (
    <Box borderStyle="round" borderColor={theme.warning}>
      <Text color={theme.warning}>{`Remove ${tool}? [y]es / [N]o`}</Text>
    </Box>
  );
}
