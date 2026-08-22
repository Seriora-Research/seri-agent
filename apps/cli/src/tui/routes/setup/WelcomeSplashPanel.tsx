/** @jsxImportSource @opentui/react */
// The welcome-splash phase's own panel — mirrors SetupList's up/down-arrow + Enter navigation
// (SetupPanel.tsx), not ModelPicker's: only 2-3 items, so no typeahead filter is needed. Not
// windowed by hooks/useListWindow.ts (ui/ListRow.tsx's own comment) — a fixed, short list with no
// scroll. Named `WelcomeSplashPanel`, not `WelcomeSplash`, so this file's own name doesn't collide
// with sibling `welcomeSplash.ts`'s on a case-insensitive filesystem (NTFS) — the same reasoning
// `SetupPanel.tsx` already disambiguates from `guidedSetup.ts`, just spelled out here because
// `WelcomeSplash`/`welcomeSplash` differ only in case where `SetupPanel`/`guidedSetup` don't.

import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { theme } from "../../theme/theme";
import { ListRow } from "../../ui/ListRow";

export function WelcomeSplashPanel({
  authenticated,
  onLogin,
  onSignup,
  onContinue,
}: {
  authenticated: boolean;
  onLogin?: () => void;
  onSignup?: () => void;
  onContinue?: () => void;
}) {
  const items = authenticated
    ? [{ label: "Continue", onSelect: onContinue }]
    : [
        { label: "Log in", onSelect: onLogin },
        { label: "Sign up", onSelect: onSignup },
        { label: "Continue without logging in", onSelect: onContinue },
      ];
  const [selected, setSelected] = useState(0);

  useKeyboard((key) => {
    if (key.name === "escape") {
      onContinue?.();
      return;
    }
    if (key.name === "up") {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }
    if (key.name === "down") {
      setSelected((current) => Math.min(items.length - 1, current + 1));
      return;
    }
    if (key.name === "return" || key.name === "kpenter" || key.name === "linefeed") {
      items[selected]?.onSelect?.();
    }
  });

  return (
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text>SERI</text>
      {items.map((item, index) => (
        <ListRow key={item.label} selected={index === selected} label={item.label} />
      ))}
      <text fg={theme.muted}>↑/↓ move · Enter select · Esc continue</text>
    </box>
  );
}
