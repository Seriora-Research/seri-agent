// Stage A scaffolding (cli-commands-to-tui feature-plan.md): AuthBanner/AuthPanel have no
// dispatcher wired to them yet — Stage C wires /login and /signup to fire `auth-offer` and
// `auth-requested`/`auth-step`/`auth-resolved`. New code, not a move.

import { Box, Text, useInput } from "ink";
import { singleLine } from "../format";
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
      {/* `wrap="truncate-end"`: APP_CHROME_ROWS (format.ts) counts this box as exactly 3 rows —
      2 border + 1 text. Below ~58 columns this fixed string would otherwise soft-wrap to a
      second text row, making the box 4 rows and pushing an open panel's own bottom row past the
      alt-screen viewport. */}
      <Text color={theme.accent} wrap="truncate-end">
        Sign in with /login, or create an account with /signup
      </Text>
    </Box>
  );
}

// /login and /signup's own blocking device-flow panel — mirrors SetupPanel's step-dispatcher
// shape, one branch per step. `onDismiss` is called from Escape on every step, plus Enter on
// "result" (SetupConfirmRemove's own Esc-cancels convention, SetupPanel.tsx, is the closest
// precedent for "either key just closes it" — used on "result" only, where an explicit
// confirmation reads naturally; Escape alone covers "starting"/"device").
//
// Bug fix (thermo-nuclear + code-review, round 4): before Escape worked here at all, neither it
// nor Ctrl-C (wired to onCancel, not to clearing pendingAuth — a raw Ctrl-C during "starting"/
// "device" fell through to a hard process kill, no turn being in flight to arm the cancel slot)
// gave the user any way out of a mistyped /login or a WorkOS device flow just sitting there for
// however long the code stays valid. Dismissing here DOES cancel the in-flight HTTP poll itself
// (round 5): onDismiss -> onAuthResolved's own onAbandon call (App.tsx/cli.ts) aborts the current
// attempt's AbortController, which pollForToken (deviceFlow.ts) actually checks and stops on —
// not just a dispatch guard muting whatever that attempt eventually does in the background.
export function AuthPanel({ state, onDismiss }: { state: AuthPanelState; onDismiss?: () => void }) {
  useInput((_input, key) => {
    if (key.escape) {
      onDismiss?.();
      return;
    }
    if (state.step === "result" && key.return) onDismiss?.();
  });

  if (state.step === "starting") {
    return (
      <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
        <Text color={theme.muted}>{`Starting ${state.mode}…`}</Text>
        <Text color={theme.muted}>Esc cancel</Text>
      </Box>
    );
  }
  if (state.step === "device") {
    return (
      <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
        <Text color={theme.muted}>{`Open ${state.verificationUri} and enter this code:`}</Text>
        <Text color={theme.accent}>{state.userCode}</Text>
        <Text color={theme.muted}>Esc cancel</Text>
      </Box>
    );
  }
  return (
    <Box
      borderStyle="round"
      borderColor={state.error ? theme.error : theme.accent}
      flexDirection="column"
    >
      {/* singleLine + wrap="truncate-end": the error case comes from messageOf(err) — an
      Error#message is unbounded and free to carry a literal newline, and this panel budgets
      exactly one row for it, same reasoning as App.tsx's own commandError guard. */}
      <Text color={state.error ? theme.error : theme.accent} wrap="truncate-end">
        {singleLine(state.message)}
      </Text>
      <Text color={theme.muted}>Enter/Esc continue</Text>
    </Box>
  );
}
