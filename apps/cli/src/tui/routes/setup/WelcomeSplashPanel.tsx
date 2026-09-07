/** @jsxImportSource @opentui/react */
// Named WelcomeSplashPanel so this file does not collide with welcomeSplash.ts on case-insensitive filesystems.

import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { FRAME } from "../../theme/spacing";
import { theme } from "../../theme/theme";
import { ListRow } from "../../ui/ListRow";
import { SplashBanner, type SplashBannerInfo } from "./SplashBanner";

export function WelcomeSplashPanel({
  authenticated,
  banner,
  onLogin,
  onSignup,
  onContinue,
}: {
  authenticated: boolean;
  banner?: SplashBannerInfo;
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
    <box {...FRAME} flexDirection="column" flexGrow={1}>
      {banner === undefined ? <text>seri</text> : <SplashBanner info={banner} />}
      <box flexGrow={1} />
      {items.map((item, index) => (
        <ListRow key={item.label} selected={index === selected} label={item.label} />
      ))}
      <text fg={theme.muted}>↑/↓ move · Enter select · Esc continue</text>
    </box>
  );
}
