// Root TUI component (Phase 4, feature-plan.md). Structurally correct and wired to Phase 2's
// reducer, not feature-complete: Phase 5 wires this to driveLoop and cli.ts's slash-command
// dispatch. <Static> is the direct replacement for output.ts's console.log/process.stdout.write
// calls — the same append-only, never-repainted transcript, rendered by Ink instead of printed
// directly. Everything below it is a live region: status/spinner, a pending-write placeholder, the
// mode indicator, and a basic input box, all re-rendered in place rather than scrolled.

import type { ModelMessage } from "ai";
import { Box, Static, Text, useApp, useInput } from "ink";
import { useEffect, useReducer, useState } from "react";
import type { SessionState } from "../session/session";
import { initialTuiState, type TuiAction, tuiReducer } from "./reducer";
import { theme } from "./theme";

export type AppProps = {
  session: SessionState<ModelMessage>;
  // The seam Phase 5 wires driveLoop's dispatch through: called once on mount with the reducer's
  // own dispatch function, the same shape `useReducer` returns. Optional because Phase 4's tests
  // exercise the reducer via `connectDispatch` directly, with no live loop behind it yet.
  connectDispatch?: (dispatch: (action: TuiAction) => void) => void;
  // Submitted line from the input box — Phase 5 wires this to the task/slash-command dispatch;
  // Phase 4 has nowhere real to send it yet.
  onSubmit?: (value: string) => void;
  // True once the run this TUI is driving has finished. Ink does not auto-exit on its own — Phase
  // 1's own hello-world smoke test hung until an explicit unmount()/exit() call was added — so this
  // effect is what ends the process, rather than relying on implicit auto-exit-on-unmount (also the
  // documented workaround for a macOS-only Bun/Ink cosmetic issue: cursor invisible after exit).
  done: boolean;
};

// A tool-call line for one of the two file-mutating tools is the closest thing this phase has to a
// pending diff — a real diff renderer is out of scope here ("a simple text representation is fine
// for this phase — don't over-build", feature-plan.md). Derived from the transcript rather than a
// new reducer field, since the transcript already carries it.
function pendingChange(transcript: readonly string[], status: string): string | undefined {
  const last = transcript.at(-1);
  if (last === undefined) return undefined;
  const isFileMutation =
    status.startsWith("Running write_file") || status.startsWith("Running edit");
  return isFileMutation ? last : undefined;
}

function InputBox({ onSubmit }: { onSubmit?: (value: string) => void }) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return) {
      onSubmit?.(value);
      setValue("");
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      setValue((current) => current + input);
    }
  });

  return (
    <Box borderStyle="round" borderColor={theme.muted}>
      <Text>{value.length > 0 ? value : " "}</Text>
    </Box>
  );
}

export function App({ session, connectDispatch, onSubmit, done }: AppProps) {
  const [state, dispatch] = useReducer(tuiReducer, initialTuiState(session));
  const { exit } = useApp();

  useEffect(() => {
    connectDispatch?.(dispatch);
  }, [connectDispatch]);

  useEffect(() => {
    if (done) exit();
  }, [done, exit]);

  const pending = pendingChange(state.transcript, state.status);

  return (
    <Box flexDirection="column">
      <Static items={state.transcript}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
      {state.streaming.length > 0 && <Text>{state.streaming}</Text>}
      {pending !== undefined && (
        <Box borderStyle="round" borderColor={theme.warning}>
          <Text color={theme.warning}>{pending}</Text>
        </Box>
      )}
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={theme.accent}>{state.modeIndicator}</Text>
        {state.status.length > 0 && <Text color={theme.muted}>{state.status}</Text>}
      </Box>
      <InputBox onSubmit={onSubmit} />
    </Box>
  );
}
