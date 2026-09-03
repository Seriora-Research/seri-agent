/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import type { AuthPanelState } from "../../state/reducer";
import { PanelBox } from "../../ui/PanelBox";
import { theme } from "../../theme/theme";
import { ErrorLine } from "../../ui/ErrorLine";
import { singleLine } from "../../util/format";
import { isEnter } from "../../util/keys";

// Blocking auth panel for WorkOS device login and Grok/Codex browser OAuth. Escape on every
// step, Enter on result. Without Escape, Ctrl-C during starting/device/browser is a hard kill
// because no turn is in flight. Dismiss aborts the in-flight poll or callback server.
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
      {/* `state.error` is a single boolean discriminant on this "result" variant, so the branch
      happens once here rather than as several independently-conditional props — one of the two
      resulting elements is ErrorLine's own constant-styled alert line, the other a plain
      unstyled one, and neither needs the other's styling. `singleLine` runs on both branches
      (ErrorLine calls it internally on the error one) because either message can carry an
      embedded newline that `truncate` alone does not guard. The outer box's own `borderColor`
      ternary stays local — it styles the box, not this line. */}
      {state.error ? (
        <ErrorLine message={state.message} />
      ) : (
        <text truncate>{singleLine(state.message)}</text>
      )}
      <text fg={theme.muted}>Enter/Esc continue</text>
    </PanelBox>
  );
}
