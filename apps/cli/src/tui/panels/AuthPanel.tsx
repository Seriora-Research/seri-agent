// Stage A scaffolding (cli-commands-to-tui feature-plan.md): AuthBanner/AuthPanel have no
// dispatcher wired to them yet — Stage C wires /login and /signup to fire `auth-offer` and
// `auth-requested`/`auth-step`/`auth-resolved`. New code, not a move.

import { Box, Text, useInput } from "ink";
import type { AuthPanelState } from "../reducer";
import { theme } from "../theme";

// The non-blocking login/signup offer — a single bordered row, the same visual weight as
// ApprovalBox's own bordered box, rendered ABOVE App.tsx's render ternary rather than as one of
// its branches: unlike ApprovalBox/ModelPicker/SetupPanel this never replaces InputBox, it sits
// alongside it. Registers no useInput of its own — acting on the offer means the user types
// /login or /signup themselves (Stage C wires that dispatch), not a keypress this component
// intercepts.
export function AuthBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Box borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent}>Sign in with /login, or create an account with /signup</Text>
    </Box>
  );
}

// /login and /signup's own blocking device-flow panel — mirrors SetupPanel's step-dispatcher
// shape, one branch per step. `onDismiss` is only ever listened for on the "result" step: the
// "starting"/"device" steps already have their own resolution path (the success dispatch chain
// in cli.ts's createAuthHandlers — auth-step "device" then straight to auth-resolved via
// onMessage), so there is nothing here for the user to dismiss until a result is actually shown.
// Bug fix (coordinator follow-up on Stage C): createAuthHandlers' own catch block degrades a
// thrown login()/logout() (a denied/expired device code, a network error) to an auth-step
// "result" with no dispatch after it — before this useInput existed, that left the user staring
// at the error with InputBox gone and no keyboard path back at all, not even Ctrl-C (that's wired
// to onCancel, not to clearing pendingAuth). SetupConfirmRemove's own Esc-cancels convention
// (SetupPanel.tsx) is the closest precedent for "either key just closes it."
export function AuthPanel({ state, onDismiss }: { state: AuthPanelState; onDismiss?: () => void }) {
  useInput((_input, key) => {
    if (state.step !== "result") return;
    if (key.return || key.escape) onDismiss?.();
  });

  if (state.step === "starting") {
    return (
      <Box borderStyle="round" borderColor={theme.accent}>
        <Text color={theme.muted}>{`Starting ${state.mode}…`}</Text>
      </Box>
    );
  }
  if (state.step === "device") {
    return (
      <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
        <Text color={theme.muted}>{`Open ${state.verificationUri} and enter this code:`}</Text>
        <Text color={theme.accent}>{state.userCode}</Text>
      </Box>
    );
  }
  return (
    <Box
      borderStyle="round"
      borderColor={state.error ? theme.error : theme.accent}
      flexDirection="column"
    >
      <Text color={state.error ? theme.error : theme.accent}>{state.message}</Text>
      <Text color={theme.muted}>Enter/Esc continue</Text>
    </Box>
  );
}
