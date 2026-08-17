// The welcome-splash mount's own panel — mirrors SetupList's up/down-arrow + Enter navigation
// (SetupPanel.tsx), not ModelPicker's: only 2-3 items, so no typeahead filter is needed.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { ListRow } from "../components";
import { theme } from "../theme";

export function WelcomeSplash({
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

  useInput((_input, key) => {
    if (key.escape) {
      onContinue?.();
      return;
    }
    if (key.upArrow) {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((current) => Math.min(items.length - 1, current + 1));
      return;
    }
    if (key.return) items[selected]?.onSelect?.();
  });

  return (
    <Box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <Text>SERI</Text>
      {items.map((item, index) => (
        <ListRow key={item.label} selected={index === selected} label={item.label} />
      ))}
      <Text color={theme.muted}>↑/↓ move · Enter select · Esc continue</Text>
    </Box>
  );
}
