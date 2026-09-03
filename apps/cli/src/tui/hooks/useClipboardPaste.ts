// Ctrl-V for the four surfaces that can take text (InputBox, ModelPicker's filter, ConfigPanel's
// and SetupPanel's value steps) — the same four `usePaste` already feeds, since a read-only surface
// has nothing to paste into. Bracketed paste covers the terminal's OWN paste action (Ctrl-Shift-V,
// right-click, Cmd-V): the emulator turns those into a paste EVENT, which `usePaste` receives. A
// bare Ctrl-V is not reliably one of them, and which it is depends on the emulator: Windows
// Terminal binds Ctrl+V to paste by default, so there it never reaches seri at all — the emulator
// consumes the chord and hands `usePaste` the text. Where the paste chord is Ctrl-Shift-V or Cmd-V
// instead, Ctrl-V is forwarded, so it arrived here as an ordinary keypress and did nothing at all,
// which is not what someone pressing the chord they use everywhere else expects.
//
// This reads the OS clipboard directly instead: `createHostClipboard` is a compiled native library
// calling the platform's own clipboard over FFI, with nothing shelled out to `clip.exe`/`pbcopy`/
// `wl-copy` and no terminal cooperation asked for, so it needs neither OSC 52 nor mouse reporting.
// That also fixes what it can reach: it is the clipboard of the machine seri RUNS on, so over SSH
// it is the wrong one, and the terminal's own paste chord is what covers that case. Which is why
// this is an addition alongside `usePaste`, never a replacement for it.

import { createHostClipboard, type HostClipboardService } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef } from "react";

// One service for the process rather than one per keypress: `createHostClipboard` allocates native
// state that `dispose()` is meant to free, so a fresh one per press would strand one every time.
// Created lazily, at the first Ctrl-V, so a session that never presses it never touches the FFI.
let service: HostClipboardService | undefined;

function hostClipboard(): HostClipboardService {
  service ??= createHostClipboard();
  return service;
}

export function useClipboardPaste(onText: (text: string) => void): void {
  // The read is async and the surface can be gone before it lands — every one of the four is a
  // branch of app.tsx's own render ternary, so answering a prompt or closing a panel unmounts it
  // outright. A late result is dropped rather than pushed into a component that no longer exists.
  const mounted = useRef(true);
  useEffect(() => {
    // Set on the way in as well as cleared on the way out. A `useRef` outlives its own cleanup, so
    // a mount/cleanup/mount of the same instance — what React StrictMode does to every effect —
    // would otherwise find this already false and leave the hook silently dead for good.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "v") return;
    // Deliberately not awaited: this runs on the keypress path, which every other registered
    // handler shares, and the OS can be slow to hand the clipboard over. The `.catch` swallows
    // rather than reports because `read` already returns every expected failure as a `status` —
    // a throw here is something unforeseen, and taking a live session down over a failed paste is
    // a worse answer than the paste not happening.
    //
    // Two guards because there are two ways this fails, and the `.catch` only covers the async one.
    // `createHostClipboard` throws SYNCHRONOUSLY when there is no platform clipboard to reach at all
    // (@opentui/core 0.5.6's own `new NativeClipboardBackend(...)`: "Failed to create native
    // clipboard service") — a headless box or an SSH session, exactly where a paste was least
    // likely to work anyway. Outside the `try` that throw leaves this hook entirely, and what stops
    // it is OpenTUI's own `KeyHandler.emitWithPriority`, which wraps every registered listener in a
    // catch and `console.error`s whatever it caught. That is a dependency's internal safety net
    // rather than this hook's own answer, and it is loud: a stack trace into the renderer's console
    // on every press, from the one path here that promised not to make noise.
    try {
      void hostClipboard()
        .read({ preferredTypes: ["text/plain"] })
        .then((result) => {
          if (!mounted.current || result.status !== "read") return;
          // `preferredTypes` is a preference the backend is free to decline, not a filter — it
          // answers with whatever representation it actually picked. A clipboard holding only an
          // image comes back as `image/png` with a `read` status, and decoding those bytes as UTF-8
          // types mojibake into the surface. Any `text/*` decodes; nothing else does.
          if (!result.representation.mimeType.startsWith("text/")) return;
          const text = new TextDecoder().decode(result.representation.bytes);
          if (text.length > 0) onText(text);
        })
        .catch(() => {});
    } catch {}
  });
}
