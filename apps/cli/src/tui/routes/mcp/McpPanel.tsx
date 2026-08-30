/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { McpPanelRow } from "../../../mcp/commands";
import { mcpLoginLine } from "../../../mcp/commands";
import type { McpLoginResult } from "../../../mcp/login";
import type { McpCatalog } from "../../../mcp/types";
import { useListWindow } from "../../hooks/useListWindow";
import { theme } from "../../theme/theme";
import { ErrorLine } from "../../ui/ErrorLine";
import { ListRow } from "../../ui/ListRow";
import { formatMcpRow, singleLine } from "../../util/format";
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
  // Runs one OAuth login for the named server (mcp/login.ts, via cli.ts). Resolves rather than
  // throws for every ending, so this panel has a status to render in all five cases.
  onAuth?: (name: string) => Promise<McpLoginResult>;
  onAuthCancel?: () => void;
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

  // Extracted from the Enter handler so a finished login can enter it directly, without the user
  // pressing Enter a second time on the row they just authenticated.
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
    if (mode.kind === "connecting") return; // static busy text owns the keyboard while dialling
    // The early return below renders McpTrustPreview INSTEAD of this panel, but it sits after this
    // hook, so without this guard both handlers stay live and every key reaches the list underneath
    // the question. Verified live: "r" at the trust prompt cancelled the preview and removed the
    // server in the same keypress, and "a" opened a browser tab. It also makes the preview's own
    // "Escape is inert" contract true, which the panel-closing branch below was quietly breaking.
    if (mode.kind === "preview") return;
    if (isDismiss(key)) {
      // Esc cancels the login, not the panel. Unlike `connecting` above there is something to
      // cancel, and closing the panel instead would leave a bound listener and an open browser tab
      // with nothing left to answer them.
      if (mode.kind === "authenticating") onAuthCancel?.();
      else onMcpClose?.();
      return;
    }
    // Same rule the `connecting` guard states: the busy text owns everything else.
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
        // Straight into the dial on success: the catalog the preview shows has to be fetched with
        // the credentials this login just stored. It is still only a preview — authenticating
        // grants nothing about trust, and McpTrustPreview stays the last gate.
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
          : mode.kind === "authenticating"
            ? "Waiting for your browser… Esc cancels"
            : "↑/↓ move · Enter connect · a authenticate · r remove · Esc close"}
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
  // Descriptions are opt-in, not absent. docs/CONSTITUTION.md requires a default-on preview for an
  // MCP server because every name and description below was written by the server you are about to
  // trust, and once you do, the model reads all of it as instructions the same way it reads your
  // own prompt. Showing all of it by default did not serve that: a 20-tool server rendered a
  // screenful of prose nobody reads, which is how a hostile line hides. The default screen names
  // the count and the tool names, which is the part a person can actually check against what they
  // meant to connect, and "d" opens the descriptions for the read that matters.
  const [showDescriptions, setShowDescriptions] = useState(false);

  // Mirrors ConfirmPrompt's own contract (ui/ConfirmPrompt.tsx) rather than importing it: Enter and
  // anything unrecognised both cancel, only an explicit "y" trusts, and Escape is inert here for
  // the same reason ConfirmPrompt's own comment gives — a destructive/consequential decision should
  // not have a second, easier-to-hit-by-accident way to answer it. Composed inline instead of
  // nested inside ConfirmPrompt's own WarningBox because the tool listing above the question is
  // exactly the content ConfirmPrompt has no room for.
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
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {`Trust "${name}"? ${count} tool${count === 1 ? "" : "s"}`}
      </text>
      {showDescriptions ? (
        // `singleLine` for ErrorLine's own reason (ui/ErrorLine.tsx): a server is free to write a
        // description containing literal newlines or a fenced code block, OpenTUI renders each
        // break as a real row, and one such tool pushes the y/n question off the viewport. Collapse
        // first, then let `truncate` clip what is left to one row per tool.
        catalog.tools.map((tool) => (
          <text key={tool.toolName} fg={theme.muted} truncate wrapMode="none">
            {singleLine(`${tool.name} — ${tool.description}`)}
          </text>
        ))
      ) : (
        <text fg={theme.muted} truncate wrapMode="none">
          {catalog.tools.map((tool) => tool.name).join(", ")}
        </text>
      )}
      <text fg={theme.muted} truncate wrapMode="none">
        Written by the server; the model reads them as instructions once you trust it.
      </text>
      <text fg={theme.muted} truncate wrapMode="none">
        {showDescriptions ? "[y]es · [n]o" : "[y]es · [n]o · d descriptions"}
      </text>
    </box>
  );
}
