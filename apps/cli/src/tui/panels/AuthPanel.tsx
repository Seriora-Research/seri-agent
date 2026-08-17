// Stage A scaffolding (cli-commands-to-tui feature-plan.md): AuthBanner/AuthPanel have no
// dispatcher wired to them yet — Stage C wires /login and /signup to fire `auth-offer` and
// `auth-requested`/`auth-step`/`auth-resolved`. New code, not a move.

import { Box, Text, useInput } from "ink";
import { ErrorLine } from "../components";
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
    <Box borderStyle="single" borderColor={theme.muted}>
      {/* `wrap="truncate-end"`: APP_CHROME_ROWS (format.ts) counts this box as exactly 3 rows —
      2 border + 1 text. Below ~58 columns this fixed string would otherwise soft-wrap to a
      second text row, making the box 4 rows and pushing an open panel's own bottom row past the
      alt-screen viewport. */}
      <Text wrap="truncate-end">Sign in with /login, or create an account with /signup</Text>
    </Box>
  );
}

// /login and /signup's own blocking device-flow panel — mirrors SetupPanel's step-dispatcher
// shape, one branch per step. `onDismiss` is called from Escape on every step, plus Enter on
// "result" only, where an explicit confirmation reads naturally (Escape alone covers
// "starting"/"device"). This panel's own explicit `key.escape` check below is what makes Escape
// work here — unlike `ConfirmPrompt` (components.tsx), which never inspects `key.escape` and
// treats a bare Escape as an inert stray keypress, not a cancel.
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
      <Box borderStyle="single" borderColor={theme.muted} flexDirection="column">
        <Text color={theme.muted}>{`Starting ${state.mode}…`}</Text>
        <Text color={theme.muted}>Esc cancel</Text>
      </Box>
    );
  }
  if (state.step === "device") {
    return (
      <Box borderStyle="single" borderColor={theme.muted} flexDirection="column">
        <Text color={theme.muted}>{`Open ${state.verificationUri} and enter this code:`}</Text>
        <Text>{state.userCode}</Text>
        <Text color={theme.muted}>Esc cancel</Text>
      </Box>
    );
  }
  return (
    <Box
      borderStyle="single"
      borderColor={state.error ? theme.error : theme.muted}
      flexDirection="column"
    >
      {/* `state.error` is a single boolean discriminant on this "result" variant, so the branch
      happens once here rather than as several independently-conditional props — one of the two
      resulting elements is ErrorLine's own constant-styled alert line, the other a plain unstyled
      one, and neither needs the other's styling. `singleLine` runs on both branches (ErrorLine
      calls it internally on the error one) because either message can carry an embedded newline
      that `wrap="truncate-end"` alone does not guard. The outer Box's own `borderColor` ternary
      stays local — it styles the box, not this line. */}
      {state.error ? (
        <ErrorLine message={state.message} />
      ) : (
        <Text wrap="truncate-end">{singleLine(state.message)}</Text>
      )}
      <Text color={theme.muted}>Enter/Esc continue</Text>
    </Box>
  );
}
