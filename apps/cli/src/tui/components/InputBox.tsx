/** @jsxImportSource @opentui/react */
import { decodePasteBytes, TextAttributes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { useClipboardPaste } from "../hooks/useClipboardPaste";
import { FRAME } from "../theme/spacing";
import { theme } from "../theme/theme";
import { applyCompletion, type CompletionSource, resolveCompletion } from "../util/completion";
import { INPUT_PLACEHOLDER, slideWindow } from "../util/format";
import { isEnter, isPrintableKey, splitAtTerminator } from "../util/keys";
import { COMPLETION_POPUP_ROWS, CompletionPopup } from "./CompletionPopup";

// A stable identity for the popup's "selection at the top, window unscrolled" state, so the two
// places that reset it (a value change, an accepted completion) cannot drift apart.
const COMPLETION_WINDOW_TOP: { selected: number; offset: number } = { selected: 0, offset: 0 };

// Ceiling on how often a keystroke can trigger InputBox's own repaint (a `setValue` call).
// OS key-repeat while holding Backspace fires faster than this (~33ms apart, measured under Ink),
// so a held key coalesces into fewer repaints; any humanly-paced keystroke, including fast
// intentional typing, is spaced further apart than this and always gets its own immediate
// (leading-edge) repaint. Scoped to InputBox's own local state only.
//
// Kept, not dropped, for the hand-rolled OpenTUI port too — verified, not assumed:
// `useKeyboard`'s own doc comment confirms held-key repeats are delivered as
// ordinary press events (`repeated: true`), the same firehose Ink's `useInput` produced, and this
// file's own render-cost test (inputRenderCost.test.tsx's OpenTUI equivalent) asserts a rapid
// backspace burst without this throttle produces one `setValue` call per keystroke instead of one
// per THROTTLE_MS window — i.e. the coalescing this exists for is real on this renderer too, not
// just an Ink artifact.
const THROTTLE_MS = 50;

// A stable identity for the default, so the common "no completion wired" mount does not get a fresh
// array on every render.
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
  // Required, not optional. App renders this component only when a submitted line has somewhere to
  // go (see its own render ternary): the pre-session mounts — the welcome splash and the guided
  // setup, routes/setup/ — have no session behind them, and an optional `onSubmit` would let them
  // render a box that echoes a typed task and then drops it on Enter.
  onSubmit: (value: string) => void;
  onQuit?: () => void;
  // Escape, once the completion popup below has had its say. Handling it HERE rather than in an
  // App-level useKeyboard is the whole of this feature's Escape precedence, and it is not a style
  // choice: OpenTUI delivers every keypress to every mounted handler and there is no focus system,
  // so an App-level handler cannot see whether this box's popup is open — that state is local
  // (`dismissedFor`/`liveCompletion`) — and would cancel the in-flight turn while the user was
  // only dismissing a completion list. Every other rule then falls out of gates that already
  // exist: roster focus and a mid-edit row are covered because `inert` returns before this branch,
  // and panels and ApprovalBox are covered because they replace this component in App's own render
  // ternary. The two mounts pass different meanings — the main box cancels the turn, the queue
  // row's editor abandons the edit.
  onEscape?: () => void;
  // Leftover text from a combined-chunk terminator in a just-closed ModelPicker (see
  // reducer.ts's `pendingInputPrefill`) — read once, as this mount's own starting value, never
  // re-applied on a later mount because `onPrefillConsumed` clears it in the same tick.
  prefill?: string;
  onPrefillConsumed?: () => void;
  // Down on an empty value only — App uses this to move focus onto live subagent rows. A
  // non-empty value keeps Down inert so it cannot insert a CSI sequence or steal a half-typed line.
  onEmptyDown?: () => void;
  // When true, printable keys, paste, Enter, and Ctrl-D no-op. Empty Down still calls
  // onEmptyDown so a child view can focus the roster.
  inert?: boolean;
  // Drops this component's own chrome — the top/bottom bordered box and the "> " marker — leaving
  // the value and its block cursor. For the mount inside a queue row (components/QueueBlock.tsx),
  // which supplies its own index prefix and reverse-video band and has one terminal row to do it
  // in: the bordered form would make an edited row three rows tall and replace its index with a
  // second "> " prompt. Default false, so no existing call site changes.
  bare?: boolean;
  // Every source a typed trigger could open (util/completion.ts). Empty by default so the
  // pre-session mounts, which have no registry behind them, render exactly as before.
  completionSources?: readonly CompletionSource[];
  // App reads this on the same keypress it might otherwise treat as a transcript scroll (a wheel
  // notch is Up/Down once mouse reporting is off). Set for as long as the completion popup owns
  // those arrows, cleared on unmount so a remount cannot leave the flag stuck.
  arrowsReservedRef?: MutableRefObject<boolean>;
}) {
  const sources = completionSources ?? EMPTY_SOURCES;
  const [value, setValue] = useState(prefill ?? "");
  // The completion popup's highlighted row and the window it scrolls, held as ONE state moved
  // together by `slideWindow` — the same clamp-don't-re-center rule and the same one-updater shape
  // every panel list gets from hooks/useListWindow.ts, which this cannot reuse directly because
  // the popup's window is a fixed COMPLETION_POPUP_ROWS budget rather than useListWindow's own
  // terminal-height-derived one. `selected` is an index into the FULL match list, never into the
  // visible slice: clamping it to the slice is what used to make the list unscrollable, stranding
  // the selection on the last visible row with every later match unreachable. Both reset to 0 on
  // every value change rather than kept in sync with a moving match list: after another keystroke
  // the list is a different list, and a preserved index would point at an unrelated entry.
  const [completionWindow, setCompletionWindow] = useState(COMPLETION_WINDOW_TOP);
  // Set to the value the user pressed Escape on, so the popup stays shut for that exact text and
  // reopens the moment they type anything else. Without it, Escape would be undone by the next
  // render.
  const [dismissedFor, setDismissedFor] = useState<string | undefined>(undefined);
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
  // would fire into a NEW mount's setValue — clear it rather than let that happen. The reserved
  // flag is the same shape: a remount that forgot to clear it would keep App from scrolling until
  // some later keystroke rewrote it.
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

  // Recomputed from the up-to-the-keystroke ref, not the throttled `value`: the popup has to answer
  // for the character just typed, and a 50ms-stale list would accept the wrong item on a fast
  // type-then-Tab.
  function liveCompletion() {
    const current = pendingValueRef.current;
    if (inert || sources.length === 0 || current === dismissedFor) return undefined;
    return resolveCompletion(sources, current);
  }

  if (arrowsReservedRef !== undefined) {
    arrowsReservedRef.current = liveCompletion() !== undefined;
  }

  // Every value change opens a fresh list, so the selection goes back to the top and any earlier
  // Escape stops applying.
  function updateAndResetCompletion(next: string) {
    scheduleUpdate(next);
    setCompletionWindow(COMPLETION_WINDOW_TOP);
    if (dismissedFor !== undefined) setDismissedFor(undefined);
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
    if (inert) {
      if (key.name === "down" && pendingValueRef.current === "") {
        onEmptyDown?.();
      }
      return;
    }
    // The popup owns Up/Down/Tab/Escape, and Enter, only while it is open. Checked before every
    // other branch below so an open popup cannot submit the half-typed name underneath it.
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
      // Enter on a name already typed in full submits it rather than "completing" it to the text
      // that is already there, which swallows the keypress. Verified live: typing `/skills` and
      // pressing Enter left the popup up and ran nothing, reading as dropped input. Tab is exempt
      // — it unambiguously means "complete this", and completing an exact match is a harmless
      // no-op that still adds the trailing space. Anything this does not claim falls through to
      // the ordinary handling below, submit included.
      const alreadyComplete = isEnter(key) && item?.value === open.token;
      if ((key.name === "tab" || isEnter(key)) && item !== undefined && !alreadyComplete) {
        const next = applyCompletion(pendingValueRef.current, open, item);
        // Synchronous, not scheduleUpdate: a pending throttled flush holding the pre-accept text
        // would otherwise land after this and undo the completion.
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
    // Below the popup block above, which returns on its own Escape, and above everything else: an
    // Escape that reaches here is one the popup did not want. See `onEscape`'s own comment for why
    // this branch lives in this component rather than in an App-level handler.
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
      updateAndResetCompletion(pendingValueRef.current.slice(0, -1));
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
      updateAndResetCompletion(pendingValueRef.current + key.sequence);
    }
  });

  // OpenTUI delivers a terminal paste as its OWN event (bracketed paste), never through
  // `useKeyboard` — unlike Ink, which handed a paste to `useInput` as one oversized `input` chunk
  // indistinguishable from typed keys. `splitAtTerminator` (util/keys.ts) applies unchanged in
  // substance: everything before the first `\r`/`\n` submits now, same as pressing Enter right
  // there; everything after becomes the new input value, awaiting its own Enter rather than being
  // silently swallowed or further auto-split.
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

  // Ctrl-V, which no terminal turns into the paste event above — see the hook's own comment. It
  // lands on the same `insertPastedText`, so a bare Ctrl-V and the terminal's own paste chord
  // cannot come to disagree about what a pasted newline does.
  useClipboardPaste(insertPastedText);

  // Derived from the throttled `value`, not the ref: this is the render path, and rendering from a
  // ref would not repaint on its own anyway.
  const completion =
    inert || sources.length === 0 || value === dismissedFor
      ? undefined
      : resolveCompletion(sources, value);

  // The value and its caret, shared by both forms below so the two can never disagree on how a
  // block cursor is drawn. INVERSE on a single space is exactly a solid caret (theme/theme.ts's own
  // note on where that attribute survives), and there is no cursor-position tracking here — the
  // handlers above only append to and delete from the end — so it always trails the text.
  // `flexShrink={0}` on both: OpenTUI's own default is 1, so a narrow terminal would otherwise
  // squeeze the marker and the cursor to make room for the placeholder below instead of clipping
  // the placeholder, which is the only one of the three that can afford to lose characters.
  const field = (
    <>
      <text fg={theme.text} flexShrink={0}>
        {bare ? value : `> ${value}`}
      </text>
      <text attributes={TextAttributes.INVERSE} flexShrink={0}>
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
        {/* "> " matches the same marker the transcript's own user-turn echo uses (cli.ts's
      echoUserInput), so it's visually clear where typed text goes. */}
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
