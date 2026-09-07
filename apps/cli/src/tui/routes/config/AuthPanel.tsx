/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import type { AuthPanelState } from "../../state/reducer";
import { PanelBox } from "../../ui/PanelBox";
import { theme } from "../../theme/theme";
import { ErrorLine } from "../../ui/ErrorLine";
import { singleLine } from "../../util/format";
import { isEnter } from "../../util/keys";

function authModeLabel(mode: string): string {
  if (mode === "grok") return "Grok subscription";
  if (mode === "codex") return "ChatGPT plan";
  return mode;
}

export function AuthPanel({ state, onDismiss }: { state: AuthPanelState; onDismiss?: () => void }) {
  useKeyboard((key) => {
    if (key.name === "escape") {
      onDismiss?.();
      return;
    }
    if (state.step === "result" && isEnter(key)) onDismiss?.();
  });

  if (state.step === "starting") {
    return (
      <PanelBox title="login">
        <text fg={theme.muted}>{`Starting ${authModeLabel(state.mode)}…`}</text>
        <text fg={theme.muted}>Esc cancel</text>
      </PanelBox>
    );
  }
  if (state.step === "device") {
    return (
      <PanelBox title="login">
        <text fg={theme.muted}>{`Open ${state.verificationUri} and enter this code:`}</text>
        <text>{state.userCode}</text>
        <text fg={theme.muted}>Esc cancel</text>
      </PanelBox>
    );
  }
  if (state.step === "browser") {
    return (
      <PanelBox title="login">
        <text
          fg={theme.muted}
        >{`Open ${state.verificationUri} to approve ${authModeLabel(state.mode)}`}</text>
        <text fg={theme.muted}>Waiting for the browser. Esc cancel</text>
      </PanelBox>
    );
  }
  return (
    <PanelBox title="login" borderColor={state.error ? theme.error : theme.muted}>
      {/* OpenTUI truncate does not collapse embedded newlines; singleLine runs on both branches. */}
      {state.error ? (
        <ErrorLine message={state.message} />
      ) : (
        <text truncate>{singleLine(state.message)}</text>
      )}
      <text fg={theme.muted}>Enter/Esc continue</text>
    </PanelBox>
  );
}
