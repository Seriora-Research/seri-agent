/** @jsxImportSource @opentui/react */
import { decodePasteBytes, TextAttributes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { theme } from "../theme/theme";
import { isEnter, isPrintableKey, splitAtTerminator } from "../util/keys";

// Ceiling on how often a keystroke can trigger InputBox's own repaint (a `setValue` call).
// OS key-repeat while holding Backspace fires faster than this (~33ms apart, measured under Ink),
// so a held key coalesces into fewer repaints; any humanly-paced keystroke, including fast
// intentional typing, is spaced further apart than this and always gets its own immediate
// (leading-edge) repaint. Scoped to InputBox's own local state only.
//
// Kept, not dropped, for the hand-rolled OpenTUI port too — verified, not assumed (Phase 1's own
// open question): `useKeyboard`'s own doc comment confirms held-key repeats are delivered as
// ordinary press events (`repeated: true`), the same firehose Ink's `useInput` produced, and this
// file's own render-cost test (inputRenderCost.test.tsx's OpenTUI equivalent) asserts a rapid
// backspace burst without this throttle produces one `setValue` call per keystroke instead of one
// per THROTTLE_MS window — i.e. the coalescing this exists for is real on this renderer too, not
// just an Ink artifact.
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

  useKeyboard((key) => {
    if (isEnter(key)) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      onSubmit?.(pendingValueRef.current);
      // Synchronous, not scheduleUpdate("") — a stale already-scheduled flush must never be able
      // to fire after this and repopulate the just-cleared box with pre-submit content.
      pendingValueRef.current = "";
      setValue("");
      // Forget when the last flush happened, not just what it flushed: a keystroke typed right
      // after this submit starts a fresh interaction and must get its own leading-edge render,
      // not be throttled against a flush that predates this submit.
      lastFlushRef.current = 0;
      return;
    }
    // Ctrl-D, the normal Unix "end input" convention — the same graceful-quit path app.tsx's own
    // onQuit prop (wired by runTui) triggers.
    if (key.ctrl && key.name === "d") {
      onQuit?.();
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      scheduleUpdate(pendingValueRef.current.slice(0, -1));
      return;
    }
    // A plain, printable keypress (util/keys.ts's own comment explains the OpenTUI-vs-Ink
    // distinction `isPrintableKey` reconstructs). Paste is never delivered through this handler
    // under OpenTUI (bracketed paste is its own event, `usePaste` below) — unlike Ink, which
    // handed a paste to `useInput` as one oversized `input` chunk indistinguishable from typed
    // keys. A single keypress's own `sequence` is never more than one grapheme, so the
    // terminator-splitting logic that used to live in this branch moved to `usePaste`'s handler
    // below, where a multi-character chunk can actually occur.
    if (isPrintableKey(key)) {
      scheduleUpdate(pendingValueRef.current + key.sequence);
    }
  });

  // OpenTUI delivers a terminal paste as its OWN event (bracketed paste), never through
  // `useKeyboard` — unlike Ink, which handed a paste to `useInput` as one oversized `input` chunk
  // indistinguishable from typed keys. `splitAtTerminator` (util/keys.ts) applies unchanged in
  // substance: everything before the first `\r`/`\n` submits now, same as pressing Enter right
  // there; everything after becomes the new input value, awaiting its own Enter rather than being
  // silently swallowed or further auto-split.
  usePaste((event) => {
    const text = decodePasteBytes(event.bytes);
    const split = splitAtTerminator(text);
    if (split === null) {
      scheduleUpdate(pendingValueRef.current + text);
      return;
    }
    onSubmit?.(pendingValueRef.current + split.before);
    scheduleUpdate(split.after);
  });

  return (
    <box
      flexDirection="row"
      borderStyle="single"
      borderColor={theme.muted}
      border={["top", "bottom"]}
    >
      {/* "> " matches the same marker the transcript's own user-turn echo uses (cli.ts's
      echoUserInput), so it's visually clear where typed text goes. There is no cursor-position
      tracking here — the keyboard/paste handlers above only append to/delete from the end of
      `value` — so a block cursor always trails the text rather than needing its own coordinate. */}
      <text>{`> ${value}`}</text>
      <text attributes={TextAttributes.INVERSE}> </text>
    </box>
  );
}
