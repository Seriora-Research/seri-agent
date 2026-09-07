/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { McpPanelRow } from "../../../mcp/commands";
import { mcpLoginLine } from "../../../mcp/commands";
import type { McpLoginResult } from "../../../mcp/login";
import type { McpCatalog } from "../../../mcp/types";
import { useListWindow } from "../../hooks/useListWindow";
import { PanelBox } from "../../ui/PanelBox";
import { theme } from "../../theme/theme";
import { ErrorLine } from "../../ui/ErrorLine";
import { ListRow } from "../../ui/ListRow";
import { formatMcpRow, singleLine } from "../../util/format";
import { isDismiss, isEnter, isPrintableKey } from "../../util/keys";

type HeaderRow = Extract<McpPanelRow, { kind: "header" }>;
type ServerRow = Extract<McpPanelRow, { kind: "server" }>;

type Mode =
  | { kind: "list" }
  | { kind: "connecting"; name: string }
  | { kind: "authenticating"; name: string }
  | { kind: "preview"; name: string; catalog: McpCatalog };

export function McpPanel({
  rows,
  onConnect,
  onTrust,
  onRemove,
  onAuth,
  onAuthCancel,
  onMcpClose,
}: {
  rows: readonly McpPanelRow[];
  onConnect?: (
    name: string,
  ) => Promise<{ ok: true; catalog: McpCatalog } | { ok: false; message: string }>;
  onTrust?: (catalog: McpCatalog) => void;
  onRemove?: (name: string) => void;
  onAuth?: (name: string) => Promise<McpLoginResult>;
  onAuthCancel?: () => void;
  onMcpClose?: () => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [dialError, setDialError] = useState<string | undefined>(undefined);

  const serverRows = rows.filter((row): row is ServerRow => row.kind === "server");
  const { selected, visible, remainingCount, handleArrowKey } = useListWindow(serverRows);

  function startConnect(name: string): void {
    if (onConnect === undefined) {
      setMode({ kind: "list" });
      return;
    }
    setDialError(undefined);
    setMode({ kind: "connecting", name });
    onConnect(name).then((result) => {
      if (result.ok) {
        setMode({ kind: "preview", name, catalog: result.catalog });
      } else {
        setMode({ kind: "list" });
        setDialError(result.message);
      }
    });
  }

  useKeyboard((key) => {
    if (mode.kind === "connecting") return;
    if (mode.kind === "preview") return;
    if (isDismiss(key)) {
      if (mode.kind === "authenticating") onAuthCancel?.();
      else onMcpClose?.();
      return;
    }
    if (mode.kind === "authenticating") return;
    if (handleArrowKey(key)) return;
    const row = serverRows[selected];
    if (isEnter(key)) {
      if (row === undefined) return;
      startConnect(row.name);
      return;
    }
    if (!isPrintableKey(key)) return;
    if (row === undefined) return;
    const pressed = key.sequence.toLowerCase();
    if (pressed === "r") {
      onRemove?.(row.name);
      return;
    }
    if (pressed === "a" && onAuth !== undefined) {
      setDialError(undefined);
      setMode({ kind: "authenticating", name: row.name });
      onAuth(row.name).then((result) => {
        if (result.status === "success") {
          startConnect(row.name);
          return;
        }
        setMode({ kind: "list" });
        setDialError(mcpLoginLine(row.name, result));
      });
    }
  });

  if (mode.kind === "preview") {
    return (
      <McpTrustPreview
        name={mode.name}
        catalog={mode.catalog}
        onTrust={() => {
          onTrust?.(mode.catalog);
          setMode({ kind: "list" });
        }}
        onCancel={() => setMode({ kind: "list" })}
      />
    );
  }

  const visibleNames = new Set(visible.map((entry) => entry.row.name));
  const groups: { header?: HeaderRow; entry: { row: ServerRow; isSelected: boolean } }[] = [];
  let pendingHeader: HeaderRow | undefined;
  for (const row of rows) {
    if (row.kind === "header") {
      pendingHeader = row;
      continue;
    }
    if (!visibleNames.has(row.name)) continue;
    const entry = visible.find((v) => v.row.name === row.name);
    if (entry === undefined) continue;
    groups.push({ header: pendingHeader, entry });
    pendingHeader = undefined;
  }

  return (
    <PanelBox title="MCP servers">
      {serverRows.length === 0 ? (
        <text fg={theme.muted} truncate wrapMode="none">
          No MCP servers configured. Add one with /mcp add &lt;name&gt; &lt;url&gt;.
        </text>
      ) : (
        <>
          <text fg={theme.muted} truncate wrapMode="none">
            {`${serverRows.length} ${serverRows.length === 1 ? "server" : "servers"}`}
          </text>
          {groups.map(({ header, entry }) => (
            <box key={entry.row.name} flexDirection="column">
              {header !== undefined && (
                <text fg={theme.muted} attributes={TextAttributes.BOLD} truncate wrapMode="none">
                  {formatMcpRow(header)}
                </text>
              )}
              <ListRow selected={entry.isSelected} label={formatMcpRow(entry.row)} />
            </box>
          ))}
          {remainingCount > 0 && <text fg={theme.muted}>↓ {remainingCount} more below</text>}
        </>
      )}
      <ErrorLine message={dialError} />
      <text fg={theme.muted} truncate wrapMode="none">
        {mode.kind === "connecting"
          ? "Connecting…"
          : mode.kind === "authenticating"
            ? "Waiting for your browser… Esc cancels"
            : "↑/↓ move · Enter connect · a authenticate · r remove · Esc close"}
      </text>
    </PanelBox>
  );
}

function McpTrustPreview({
  name,
  catalog,
  onTrust,
  onCancel,
}: {
  name: string;
  catalog: McpCatalog;
  onTrust: () => void;
  onCancel: () => void;
}) {
  const [showDescriptions, setShowDescriptions] = useState(false);

  useKeyboard((key) => {
    if (isEnter(key)) {
      onCancel();
      return;
    }
    if (!isPrintableKey(key)) return;
    const pressed = key.sequence.toLowerCase();
    if (pressed === "d") {
      setShowDescriptions(true);
      return;
    }
    if (pressed === "y") {
      onTrust();
      return;
    }
    onCancel();
  });

  const count = catalog.tools.length;
  return (
    <PanelBox title="MCP servers">
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {`Trust "${name}"? ${count} tool${count === 1 ? "" : "s"}`}
      </text>
      {showDescriptions ? (
        // MCP strings are server-written; OpenTUI turns embedded newlines into real rows, so singleLine them.
        catalog.tools.map((tool) => (
          <text key={tool.toolName} fg={theme.muted} truncate wrapMode="none">
            {singleLine(`${tool.name} — ${tool.description}`)}
          </text>
        ))
      ) : (
        <text fg={theme.muted} truncate wrapMode="none">
          {singleLine(catalog.tools.map((tool) => tool.name).join(", "))}
        </text>
      )}
      <text fg={theme.muted} truncate wrapMode="none">
        Written by the server; the model reads them as instructions once you trust it.
      </text>
      <text fg={theme.muted} truncate wrapMode="none">
        {showDescriptions ? "[y]es · [n]o" : "[y]es · [n]o · d descriptions"}
      </text>
    </PanelBox>
  );
}
