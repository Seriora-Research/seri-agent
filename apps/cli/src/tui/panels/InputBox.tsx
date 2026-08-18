// Extracted out of App.tsx (Stage A, cli-commands-to-tui feature-plan.md) verbatim: a pure move,
// no behavior change.

import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { theme } from "../theme";

export function InputBox({
  onSubmit,
  onQuit,
  prefill,
  onPrefillConsumed,
}: {
  onSubmit?: (value: string) => void;
  onQuit?: () => void;
  // Leftover text from a combined-chunk terminator in a just-closed ModelPicker (see
  // reducer.ts's `pendingInputPrefill`) — read once, as this mount's own starting value, never
  // re-applied on a later mount because `onPrefillConsumed` clears it in the same tick.
  prefill?: string;
  onPrefillConsumed?: () => void;
}) {
  const [value, setValue] = useState(prefill ?? "");
  useEffect(() => {
    if (prefill !== undefined) onPrefillConsumed?.();
    // `prefill` in deps is what Biome's react-hooks rule wants, not a real re-subscription: this
    // effect only ever needs to run once, and it only ever DOES run once, because InputBox is a
    // fresh instance every time it (re)mounts (see the render ternary below) — "on mount" already
    // means "once per pick", so a changed `prefill` on an already-mounted instance never happens.
  }, [prefill, onPrefillConsumed]);

  useInput((input, key) => {
    if (key.return) {
      onSubmit?.(value);
      setValue("");
      return;
    }
    // Ctrl-D, the normal Unix "end input" convention — HIGH-1's other trigger for the same quit
    // path /exit uses (App.tsx's own onQuit prop, wired by runTui).
    if (key.ctrl && input === "d") {
      onQuit?.();
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      // MEDIUM-E: `key.return` above only fires for a chunk that IS a bare terminator on its
      // own — a paste (delivered as one multi-character `input` chunk, not one useInput call per
      // character; a pasted stack trace is the real case) can embed a `\r`/`\n` that key.return
      // never sees, so without this it fell straight into the plain append below and the
      // terminator ended up embedded literally in the input, never submitting. Splits on the
      // FIRST terminator only: everything before it submits now, same as pressing Enter right
      // there; everything after becomes the new input value, awaiting its own Enter rather than
      // being silently swallowed or further auto-split.
      const terminatorIndex = input.search(/[\r\n]/);
      if (terminatorIndex === -1) {
        setValue((current) => current + input);
        return;
      }
      const before = input.slice(0, terminatorIndex);
      // MEDIUM-4: a `\r\n` pair (a Windows-clipboard paste is the common source) is ONE
      // terminator, not two — stripping only the `\r` left a stray leading `\n` in `after`,
      // requiring an extra, confusing Enter to clear what looked like a blank line, and
      // embedding a raw `\r\n` into whatever slash-command parsing ran on it next.
      const terminatorLength = input.startsWith("\r\n", terminatorIndex) ? 2 : 1;
      const after = input.slice(terminatorIndex + terminatorLength);
      onSubmit?.(value + before);
      setValue(after);
    }
  });

  return (
    <Box borderStyle="single" borderColor={theme.muted} borderLeft={false} borderRight={false}>
      <Text>{value.length > 0 ? value : " "}</Text>
    </Box>
  );
}
