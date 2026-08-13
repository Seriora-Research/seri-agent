// Stage A scaffolding (cli-commands-to-tui feature-plan.md): AuthBanner/AuthPanel have no
// dispatcher wired to them yet — Stage C wires /login and /signup to fire `auth-offer` and
// `auth-requested`/`auth-step`/`auth-resolved`. New code, not a move.

import { Box, Text } from "ink";
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
// shape, one branch per step.
export function AuthPanel({ state }: { state: AuthPanelState }) {
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
    <Box borderStyle="round" borderColor={state.error ? theme.error : theme.accent}>
      <Text color={state.error ? theme.error : theme.accent}>{state.message}</Text>
    </Box>
  );
}
