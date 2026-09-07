/** @jsxImportSource @opentui/react */
// Named WelcomeSplashPanel so this file does not collide with welcomeSplash.ts on case-insensitive filesystems.

import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import {
  type HostedAccountAccess,
  hostedAccountAccess,
  splashAuthItems,
} from "../../../auth/hostedAccountAccess";
import { FRAME } from "../../theme/spacing";
import { theme } from "../../theme/theme";
import { ListRow } from "../../ui/ListRow";
import { SplashBanner, type SplashBannerInfo } from "./SplashBanner";

export function WelcomeSplashPanel({
  authenticated,
  hostedAccounts = hostedAccountAccess(),
  banner,
  onLogin,
  onSignup,
  onContinue,
}: {
  authenticated: boolean;
  hostedAccounts?: HostedAccountAccess;
  banner?: SplashBannerInfo;
  onLogin?: () => void;
  onSignup?: () => void;
  onContinue?: () => void;
}) {
  const handlers = { login: onLogin, signup: onSignup, continue: onContinue };
  const items = splashAuthItems(hostedAccounts, !authenticated).map((item) => ({
    label: item.label,
    onSelect: handlers[item.action],
  }));
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
