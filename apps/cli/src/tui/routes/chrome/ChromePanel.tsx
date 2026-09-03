/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { usagePanelLines, LOGGED_OUT_USAGE } from "../../../usage/format";
import type { FetchUsageResult } from "../../../usage/fetch";
import { CHROME_TABS, nextChromeTab, type ChromeTabId } from "../../chrome/tabs";
import type { ChromePanelState } from "../../state/reducer";
import { theme } from "../../theme/theme";
import { PanelBox } from "../../ui/PanelBox";
import { isDismiss } from "../../util/keys";

function TabStrip({ active }: { active: ChromeTabId }) {
  return (
    <box flexDirection="row" gap={2}>
      {CHROME_TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <box
            key={tab.id}
            backgroundColor={selected ? theme.selectedBg : undefined}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={selected ? theme.selectedFg : theme.muted}>{tab.label}</text>
          </box>
        );
      })}
    </box>
  );
}

function UsageBody({ load, detail }: { load: ChromePanelState["load"]; detail: boolean }) {
  if (load.status === "loading") {
    return <text fg={theme.muted}>Loading hosted usage…</text>;
  }
  if (load.status === "logged-out") {
    return <text fg={theme.text}>{LOGGED_OUT_USAGE}</text>;
  }
  if (load.status === "error") {
    return <text fg={theme.text}>{load.message}</text>;
  }
  const lines = usagePanelLines(load.report, {
    detail,
    staleFrom: load.staleFrom,
  });
  return (
    <box flexDirection="column">
      {lines.map((line, index) => (
        <text key={`${index}:${line}`} fg={line.length === 0 ? theme.muted : theme.text}>
          {line.length === 0 ? " " : line}
        </text>
      ))}
    </box>
  );
}

export function ChromePanel({
  pendingChrome,
  onChromeTab,
  onChromeClose,
}: {
  pendingChrome: ChromePanelState;
  onChromeTab?: (tab: ChromeTabId) => void;
  onChromeClose?: (leftoverInput?: string) => void;
}) {
  useKeyboard((key) => {
    if (isDismiss(key)) {
      onChromeClose?.();
      return;
    }
    if (key.name === "left") {
      onChromeTab?.(nextChromeTab(pendingChrome.tab, -1));
      return;
    }
    if (key.name === "right") {
      onChromeTab?.(nextChromeTab(pendingChrome.tab, 1));
    }
  });

  return (
    <PanelBox title={`/${pendingChrome.tab}`} flexGrow={1}>
      <TabStrip active={pendingChrome.tab} />
      <box height={1}>
        <text> </text>
      </box>
      {pendingChrome.tab === "usage" ? (
        <UsageBody load={pendingChrome.load} detail={pendingChrome.detail} />
      ) : null}
      <box height={1}>
        <text> </text>
      </box>
      <text fg={theme.muted}>
        {pendingChrome.detail ? "esc close" : "esc close   --detail routes"}
      </text>
    </PanelBox>
  );
}

export function chromeLoadFromFetch(result: FetchUsageResult): ChromePanelState["load"] {
  if (result.status === "logged-out") return { status: "logged-out" };
  if (result.status === "error") return { status: "error", message: result.message };
  if (result.status === "stale") {
    return { status: "ok", report: result.report, staleFrom: result.fetchedAt };
  }
  return { status: "ok", report: result.report };
}
