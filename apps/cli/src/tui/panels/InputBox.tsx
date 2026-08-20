// Extracted out of App.tsx (Stage A, cli-commands-to-tui feature-plan.md) verbatim: a pure move,
// no behavior change.

import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { theme } from "../theme";

// Ceiling on how often a keystroke can trigger InputBox's own repaint (a `setValue` call).
// OS key-repeat while holding Backspace fires faster than this (~33ms apart, measured), so a
// held key coalesces into fewer repaints; any humanly-paced keystroke, including fast
// intentional typing, is spaced further apart than this and always gets its own immediate
// (leading-edge) repaint. Scoped to InputBox's own local state only — does not touch Ink's
// global `maxFps`, so it has no effect on unrelated render paths like streamed model output.
const THROTTLE_MS = 50;

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
  // The current input value at all times, kept in sync synchronously on every keystroke.
  // `value` (React state) only mirrors this, and only on a throttled `flush()` — reads that need
  // the up-to-the-keystroke value (submit) must read this ref, not `value`.
  const pendingValueRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushRef = useRef(0);

  useEffect(() => {
    if (prefill !== undefined) onPrefillConsumed?.();
    // `prefill` in deps is what Biome's react-hooks rule wants, not a real re-subscription: this
    // effect only ever needs to run once, and it only ever DOES run once, because InputBox is a
    // fresh instance every time it (re)mounts (see the render ternary below) — "on mount" already
    // means "once per pick", so a changed `prefill` on an already-mounted instance never happens.
  }, [prefill, onPrefillConsumed]);

  // InputBox remounts fresh on every panel swap (see above), so a timer left running past unmount
  // would fire into a NEW mount's setValue — clear it rather than let that happen.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  function flush() {
    timerRef.current = null;
    lastFlushRef.current = Date.now();
    setValue(pendingValueRef.current);
  }

  function scheduleUpdate(next: string) {
    pendingValueRef.current = next;
    if (timerRef.current !== null) return; // a flush is already scheduled; it will pick up `next`
    const elapsed = Date.now() - lastFlushRef.current;
    if (elapsed >= THROTTLE_MS) {
      flush();
      return;
    }
    timerRef.current = setTimeout(flush, THROTTLE_MS - elapsed);
  }

  useInput((input, key) => {
    if (key.return) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      onSubmit?.(pendingValueRef.current);
      // Synchronous, not scheduleUpdate("") — a stale already-scheduled flush must never be able
      // to fire after this and repopulate the just-cleared box with pre-submit content.
      pendingValueRef.current = "";
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
      scheduleUpdate(pendingValueRef.current.slice(0, -1));
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
        scheduleUpdate(pendingValueRef.current + input);
        return;
      }
      const before = input.slice(0, terminatorIndex);
      // MEDIUM-4: a `\r\n` pair (a Windows-clipboard paste is the common source) is ONE
      // terminator, not two — stripping only the `\r` left a stray leading `\n` in `after`,
      // requiring an extra, confusing Enter to clear what looked like a blank line, and
      // embedding a raw `\r\n` into whatever slash-command parsing ran on it next.
      const terminatorLength = input.startsWith("\r\n", terminatorIndex) ? 2 : 1;
      const after = input.slice(terminatorIndex + terminatorLength);
      onSubmit?.(pendingValueRef.current + before);
      scheduleUpdate(after);
    }
  });

  return (
    <Box borderStyle="single" borderColor={theme.muted} borderLeft={false} borderRight={false}>
      {/* "> " matches the same marker the transcript's own user-turn echo uses (cli.ts's
      echoUserInput), so it's visually clear where typed text goes. There is no cursor-position
      tracking here — useInput only appends to/deletes from the end of `value` — so a block cursor
      always trails the text rather than needing its own coordinate. */}
      <Text>{`> ${value}`}</Text>
      <Text inverse> </Text>
    </Box>
  );
}
