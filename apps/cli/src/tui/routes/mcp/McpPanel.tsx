/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { McpPanelRow } from "../../../mcp/commands";
import type { McpCatalog } from "../../../mcp/types";
import { useListWindow } from "../../hooks/useListWindow";
import { theme } from "../../theme/theme";
import { ErrorLine } from "../../ui/ErrorLine";
import { ListRow } from "../../ui/ListRow";
import { formatMcpRow } from "../../util/format";
import { isDismiss, isEnter, isPrintableKey } from "../../util/keys";

type HeaderRow = Extract<McpPanelRow, { kind: "header" }>;
type ServerRow = Extract<McpPanelRow, { kind: "server" }>;

// /mcp's own live state — SkillsPanel's structure (bordered box, header, useListWindow) plus one
// mode this panel alone needs: a dial is network I/O, so "connecting" and "preview" live here as
// component state rather than the reducer, the same "reducer supplies the starting point, the
// component owns the live step" split SetupEnterKey's own busy/value fields already use.
type Mode =
  | { kind: "list" }
  | { kind: "connecting"; name: string }
  | { kind: "preview"; name: string; catalog: McpCatalog };

export function McpPanel({
  rows,
  onConnect,
  onTrust,
  onRemove,
  onMcpClose,
}: {
  rows: readonly McpPanelRow[];
  // Dials the named server and hands back its catalog, or why it couldn't — the /mcp add preview
  // path (mcp/client.ts's fetchCatalog) reused for any row, not only a freshly added one, because
  // the trust decision below must always be made against a live catalog, never a stale cached one.
  onConnect?: (
    name: string,
  ) => Promise<{ ok: true; catalog: McpCatalog } | { ok: false; message: string }>;
  // Fires only on the preview's 'y' — writes the catalog to disk (mcp/registry.ts's
  // writeCatalogCache). Never called on 'n' or a failed dial, which is the whole point of asking.
  onTrust?: (catalog: McpCatalog) => void;
  onRemove?: (name: string) => void;
  onMcpClose?: () => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [dialError, setDialError] = useState<string | undefined>(undefined);

  // Headers are excluded from the array useListWindow ever sees, not filtered out of its
  // selection afterward — a header can never become `selected` in the first place, which is what
  // makes "skip during arrow navigation" true by construction rather than a second check every
  // caller of handleArrowKey has to remember to apply.
  const serverRows = rows.filter((row): row is ServerRow => row.kind === "server");
  const { selected, visible, remainingCount, handleArrowKey } = useListWindow(serverRows);

  useKeyboard((key) => {
    if (mode.kind === "connecting") return; // static busy text owns the keyboard while dialling
    if (isDismiss(key)) {
      onMcpClose?.();
      return;
    }
    if (handleArrowKey(key)) return;
    const row = serverRows[selected];
    if (isEnter(key)) {
      if (row === undefined || onConnect === undefined) return;
      setDialError(undefined);
      setMode({ kind: "connecting", name: row.name });
      onConnect(row.name).then((result) => {
        if (result.ok) {
          setMode({ kind: "preview", name: row.name, catalog: result.catalog });
        } else {
          setMode({ kind: "list" });
          setDialError(result.message);
        }
      });
      return;
    }
    if (!isPrintableKey(key)) return;
    if (row === undefined) return;
    if (key.sequence.toLowerCase() === "r") onRemove?.(row.name);
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

  // Re-pairs each visible server with the header immediately above it in `rows`' own order, so a
  // header renders exactly when the first server it groups scrolls into view and never otherwise —
  // the one new list mechanism a grouped, windowed list needs (research-mcp.md §7).
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
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        MCP servers
      </text>
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
          : "↑/↓ move · Enter connect · r remove · Esc close"}
      </text>
    </box>
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
  // Mirrors ConfirmPrompt's own contract (ui/ConfirmPrompt.tsx) rather than importing it: Enter and
  // anything unrecognised both cancel, only an explicit "y" trusts, and Escape is inert here for
  // the same reason ConfirmPrompt's own comment gives — a destructive/consequential decision should
  // not have a second, easier-to-hit-by-accident way to answer it. Composed inline instead of
  // nested inside ConfirmPrompt's own WarningBox because the catalog listing above the question is
  // exactly the content ConfirmPrompt has no room for.
  useKeyboard((key) => {
    if (isEnter(key)) {
      onCancel();
      return;
    }
    if (!isPrintableKey(key)) return;
    if (key.sequence.toLowerCase() === "y") {
      onTrust();
      return;
    }
    onCancel();
  });

  return (
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {`${name} — ${catalog.tools.length} tool${catalog.tools.length === 1 ? "" : "s"}`}
      </text>
      {catalog.tools.map((tool) => (
        <text key={tool.toolName} fg={theme.muted} truncate wrapMode="none">
          {`${tool.name} — ${tool.description}`}
        </text>
      ))}
      {/* The CONSTITUTION's default-on-preview requirement exists because this text is not
      documentation, it's an input: every name and description above was written by the server
      you're about to trust, and once you do, the model reads all of it as instructions the same
      way it reads your own prompt — a hostile server gets to try that exactly once, right here,
      before any of it reaches the model. */}
      <text fg={theme.muted} truncate wrapMode="none">
        The names and descriptions above were written by this server — the model will read them as
        instructions once you trust it, the same as anything you type yourself.
      </text>
      <text fg={theme.muted} truncate wrapMode="none">
        {`Trust "${name}" and save its tools? [y]es / [n]o`}
      </text>
    </box>
  );
}
