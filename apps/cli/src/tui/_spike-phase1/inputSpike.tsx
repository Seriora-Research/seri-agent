/** @jsxImportSource @opentui/react */
// THROWAWAY SPIKE — Phase 1 of docs/specs/025-tui-opentui-migration/tasks.md. Not production code:
// answers whether OpenTUI's native <input> fits InputBox.tsx's semantics (throttled repaint under
// a rapid backspace burst, trailing-cursor rendering, paste/multi-char-chunk terminator-splitting)
// against the real behaviors InputBox.tsx (apps/cli/src/tui/panels/InputBox.tsx) implements by
// hand today. Deleted before Phase 2's real InputBox rewrite starts.

import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { useRef, useState } from "react";

// OpenTUI's own built-in <input> component, driven the same way the real Login Form example in
// @opentui/react's README drives it (focused + onInput + onSubmit). No hand-rolled throttling,
// cursor tracking, or paste handling here at all — the whole point is finding out whether it
// needs any.
export function NativeInputSpike({
  onSubmit,
  onValueChange,
}: {
  onSubmit?: (value: string) => void;
  onValueChange?: (value: string) => void;
}) {
  return (
    <box borderStyle="single" border>
      {/* @opentui/react's own InputProps type intersects two conflicting onSubmit signatures
      (InputRenderableOptions inherits TextareaOptions' `(event: SubmitEvent) => void` without
      omitting it, then InputProps re-declares `(value: string) => void` on top) — the cast below
      works around that type-level inconsistency; the real README example (Login Form) confirms
      the RUNTIME callback receives the string value, not a SubmitEvent, for <input> specifically. */}
      <input focused onInput={onValueChange} onSubmit={onSubmit as (event: unknown) => void} />
    </box>
  );
}

// The fallback shape, for comparison: InputBox.tsx's own terminator-splitting logic ported by
// hand onto OpenTUI's useKeyboard/usePaste instead of Ink's useInput — proves the fallback is
// buildable if the native <input> above doesn't fit, without re-doing InputBox.tsx's throttle
// machinery (not needed here — see the PR-description findings on why).
export function HandRolledInputSpike({ onSubmit }: { onSubmit?: (value: string) => void }) {
  const [value, setValue] = useState("");
  const valueRef = useRef("");

  useKeyboard((key) => {
    if (key.name === "return" || key.name === "kpenter" || key.name === "linefeed") {
      onSubmit?.(valueRef.current);
      valueRef.current = "";
      setValue("");
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      valueRef.current = valueRef.current.slice(0, -1);
      setValue(valueRef.current);
      return;
    }
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length > 0) {
      valueRef.current += key.sequence;
      setValue(valueRef.current);
    }
  });

  // OpenTUI delivers a terminal paste as its OWN event (bracketed paste), never through
  // useKeyboard — unlike Ink, which hands a paste to useInput as one oversized `input` chunk
  // indistinguishable from typed keys (InputBox.tsx's own MEDIUM-E comment). The terminator-split
  // logic still has to live somewhere; here it moves from the keyboard handler to this one.
  usePaste((event) => {
    const text = decodePasteBytes(event.bytes);
    const terminatorIndex = text.search(/[\r\n]/);
    if (terminatorIndex === -1) {
      valueRef.current += text;
      setValue(valueRef.current);
      return;
    }
    const before = text.slice(0, terminatorIndex);
    const terminatorLength = text.startsWith("\r\n", terminatorIndex) ? 2 : 1;
    const after = text.slice(terminatorIndex + terminatorLength);
    onSubmit?.(valueRef.current + before);
    valueRef.current = after;
    setValue(after);
  });

  return (
    <box borderStyle="single" border>
      <text>{`> ${value}`}</text>
    </box>
  );
}
