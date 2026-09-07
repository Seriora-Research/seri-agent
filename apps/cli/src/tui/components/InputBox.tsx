/** @jsxImportSource @opentui/react */
import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { useClipboardPaste } from "../hooks/useClipboardPaste";
import { FRAME } from "../theme/spacing";
import { theme } from "../theme/theme";
import { applyCompletion, type CompletionSource, resolveCompletion } from "../util/completion";
import { INPUT_PLACEHOLDER, slideWindow } from "../util/format";
import { isEnter, isPrintableKey, splitAtTerminator } from "../util/keys";
import { COMPLETION_POPUP_ROWS, CompletionPopup } from "./CompletionPopup";

const COMPLETION_WINDOW_TOP: { selected: number; offset: number } = { selected: 0, offset: 0 };

// OpenTUI useKeyboard delivers held-key repeats as ordinary press events; this coalesces OS key-repeat into one setValue per window.
const THROTTLE_MS = 50;

const EMPTY_SOURCES: readonly CompletionSource[] = [];

export function InputBox({
  onSubmit,
  onQuit,
  onEscape,
  prefill,
  onPrefillConsumed,
  onEmptyDown,
  inert,
  bare,
  completionSources,
  arrowsReservedRef,
}: {
  onSubmit: (value: string) => void;
  onQuit?: () => void;
  // OpenTUI delivers every keypress to every handler and has no focus, so Escape precedence must live here where popup state is local.
  onEscape?: () => void;
  // Starting value from leftover picker input; onPrefillConsumed clears it the same tick.
  prefill?: string;
  onPrefillConsumed?: () => void;
  onEmptyDown?: () => void;
  // When true, printables, paste, Enter, and Ctrl-D no-op; empty Down still fires.
  inert?: boolean;
  // Drop the bordered chrome and "> " marker for a single-row queue editor.
  bare?: boolean;
  completionSources?: readonly CompletionSource[];
  arrowsReservedRef?: MutableRefObject<boolean>;
}) {
  const sources = completionSources ?? EMPTY_SOURCES;
  const [value, setValue] = useState(prefill ?? "");
  const [completionWindow, setCompletionWindow] = useState(COMPLETION_WINDOW_TOP);
  const [dismissedFor, setDismissedFor] = useState<string | undefined>(undefined);
  const pendingValueRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushRef = useRef(0);

  useEffect(() => {
    if (prefill !== undefined) onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (arrowsReservedRef !== undefined) arrowsReservedRef.current = false;
    };
  }, [arrowsReservedRef]);

  function flush() {
    timerRef.current = null;
    lastFlushRef.current = Date.now();
    setValue(pendingValueRef.current);
  }

  function liveCompletion() {
    const current = pendingValueRef.current;
    if (inert || sources.length === 0 || current === dismissedFor) return undefined;
    return resolveCompletion(sources, current);
  }

  if (arrowsReservedRef !== undefined) {
    arrowsReservedRef.current = liveCompletion() !== undefined;
  }

  function updateAndResetCompletion(next: string) {
    scheduleUpdate(next);
    setCompletionWindow(COMPLETION_WINDOW_TOP);
    if (dismissedFor !== undefined) setDismissedFor(undefined);
  }

  function scheduleUpdate(next: string) {
    pendingValueRef.current = next;
    if (timerRef.current !== null) return;
    const elapsed = Date.now() - lastFlushRef.current;
    if (elapsed >= THROTTLE_MS) {
      flush();
      return;
    }
    timerRef.current = setTimeout(flush, THROTTLE_MS - elapsed);
  }

  useKeyboard((key) => {
    if (inert) {
      if (key.name === "down" && pendingValueRef.current === "") {
        onEmptyDown?.();
      }
      return;
    }
    const open = liveCompletion();
    if (open !== undefined) {
      if (key.name === "up" || key.name === "down") {
        setCompletionWindow((current) => {
          const next =
            key.name === "up"
              ? current.selected - 1
              : Math.min(open.matches.length - 1, current.selected + 1);
          const selected = Math.max(0, next);
          return { selected, offset: slideWindow(current.offset, selected, COMPLETION_POPUP_ROWS) };
        });
        return;
      }
      if (key.name === "escape") {
        setDismissedFor(pendingValueRef.current);
        return;
      }
      const item = open.matches[completionWindow.selected] ?? open.matches[0];
      const alreadyComplete = isEnter(key) && item?.value === open.token;
      if ((key.name === "tab" || isEnter(key)) && item !== undefined && !alreadyComplete) {
        const next = applyCompletion(pendingValueRef.current, open, item);
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        pendingValueRef.current = next;
        setValue(next);
        setCompletionWindow(COMPLETION_WINDOW_TOP);
        return;
      }
    }
    if (key.name === "down" && pendingValueRef.current === "") {
      onEmptyDown?.();
      return;
    }
    if (key.name === "escape") {
      onEscape?.();
      return;
    }
    if (isEnter(key)) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      onSubmit(pendingValueRef.current);
      pendingValueRef.current = "";
      setValue("");
      lastFlushRef.current = 0;
      return;
    }
    if (key.ctrl && key.name === "d") {
      onQuit?.();
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      updateAndResetCompletion(pendingValueRef.current.slice(0, -1));
      return;
    }
    if (isPrintableKey(key)) {
      updateAndResetCompletion(pendingValueRef.current + key.sequence);
    }
  });

  // OpenTUI delivers paste as a bracketed-paste event, never through useKeyboard. A terminator submits everything before it and keeps the rest as the next value.
  function insertPastedText(text: string) {
    if (inert) return;
    const split = splitAtTerminator(text);
    if (split === null) {
      scheduleUpdate(pendingValueRef.current + text);
      return;
    }
    onSubmit(pendingValueRef.current + split.before);
    scheduleUpdate(split.after);
  }

  usePaste((event) => insertPastedText(decodePasteBytes(event.bytes)));

  // Ctrl-V is not a paste event; share insertPastedText with usePaste.
  useClipboardPaste(insertPastedText);

  const completion =
    inert || sources.length === 0 || value === dismissedFor
      ? undefined
      : resolveCompletion(sources, value);

  // OpenTUI defaults flexShrink to 1; without 0 the marker and cursor shrink before the placeholder clips.
  const field = (
    <>
      <text fg={theme.text} flexShrink={0}>
        {bare ? value : `> ${value}`}
      </text>
      <text fg={theme.onInk} bg={theme.accent} flexShrink={0}>
        {" "}
      </text>
    </>
  );

  if (bare === true) {
    return <box flexDirection="row">{field}</box>;
  }

  return (
    <>
      {completion !== undefined && (
        <CompletionPopup
          matches={completion.matches}
          selected={completionWindow.selected}
          offset={completionWindow.offset}
        />
      )}
      <box flexDirection="row" {...FRAME}>
        {field}
        {value.length === 0 && (
          <text fg={theme.muted} marginLeft={1} truncate wrapMode="none" flexGrow={1}>
            {INPUT_PLACEHOLDER}
          </text>
        )}
      </box>
    </>
  );
}
