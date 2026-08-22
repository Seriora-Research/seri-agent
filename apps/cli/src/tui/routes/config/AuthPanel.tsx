/** @jsxImportSource @opentui/react */
// AuthBanner/AuthPanel have no dispatcher wired to them yet — nothing dispatches auth-offer or
// auth-requested/auth-step/auth-resolved.

import { useKeyboard } from "@opentui/react";
import type { AuthPanelState } from "../../state/reducer";
import { theme } from "../../theme/theme";
import { ErrorLine } from "../../ui/ErrorLine";
import { singleLine } from "../../util/format";

// The non-blocking login/signup offer — a single bordered row, the same visual weight as
// ApprovalBox's own bordered box, rendered ABOVE app.tsx's render ternary rather than as one of
// its branches: unlike ApprovalBox/ModelPicker/SetupPanel this never replaces InputBox, it sits
// alongside it. Registers no keyboard handler of its own — acting on the offer means the user
// types /login or /signup themselves, not a keypress this component intercepts.
export function AuthBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <box borderStyle="single" borderColor={theme.muted}>
      {/* `truncate`: APP_CHROME_ROWS (util/format.ts) counts this box as exactly 3 rows — 2
      border + 1 text. Below ~58 columns this fixed string would otherwise soft-wrap to a second
      text row, making the box 4 rows and pushing an open panel's own bottom row past the
      alt-screen viewport. */}
      <text truncate>Sign in with /login, or create an account with /signup</text>
    </box>
  );
}

// /login and /signup's own blocking device-flow panel — mirrors SetupPanel's step-dispatcher
// shape, one branch per step. `onDismiss` is called from Escape on every step, plus Enter on
// "result" only, where an explicit confirmation reads naturally (Escape alone covers
// "starting"/"device"). This panel's own explicit `key.name === "escape"` check below is what
// makes Escape work here — unlike `ConfirmPrompt` (ui/ConfirmPrompt.tsx), which never inspects
// Escape and treats a bare Escape as an inert stray keypress, not a cancel.
//
// Escape (or Ctrl-C, cancelled via runtime/renderer.ts) is the only way out of a mistyped /login or a WorkOS
// device flow sitting there for however long the code stays valid — without an explicit Escape
// handler here, a raw Ctrl-C during "starting"/"device" would fall through to a hard process
// kill, since no turn is in flight to arm the cancel slot. Dismissing here also cancels the
// in-flight HTTP poll itself: onDismiss -> onAuthResolved's own onAbandon call (app.tsx/cli.ts)
// aborts the current attempt's AbortController, which pollForToken (deviceFlow.ts) actually
// checks and stops on — not just a dispatch guard muting whatever that attempt eventually does
// in the background.
export function AuthPanel({ state, onDismiss }: { state: AuthPanelState; onDismiss?: () => void }) {
  useKeyboard((key) => {
    if (key.name === "escape") {
      onDismiss?.();
      return;
    }
    if (
      state.step === "result" &&
      (key.name === "return" || key.name === "kpenter" || key.name === "linefeed")
    )
      onDismiss?.();
  });

  if (state.step === "starting") {
    return (
      <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
        <text fg={theme.muted}>{`Starting ${state.mode}…`}</text>
        <text fg={theme.muted}>Esc cancel</text>
      </box>
    );
  }
  if (state.step === "device") {
    return (
      <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
        <text fg={theme.muted}>{`Open ${state.verificationUri} and enter this code:`}</text>
        <text>{state.userCode}</text>
        <text fg={theme.muted}>Esc cancel</text>
      </box>
    );
  }
  return (
    <box
      borderStyle="single"
      borderColor={state.error ? theme.error : theme.muted}
      flexDirection="column"
    >
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
    </box>
  );
}
