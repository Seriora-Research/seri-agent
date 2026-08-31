// Ctrl-V for the four surfaces that can take text (InputBox, ModelPicker's filter, ConfigPanel's
// and SetupPanel's value steps) — the same four `usePaste` already feeds, since a read-only surface
// has nothing to paste into. Bracketed paste covers the terminal's OWN paste action (Ctrl-Shift-V,
// right-click, Cmd-V): the emulator turns those into a paste EVENT, which `usePaste` receives. A
// bare Ctrl-V is not one of them — no terminal treats it as a paste trigger — so it arrived as an
// ordinary keypress and did nothing at all, which is not what a Windows user pressing it expects.
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
    void hostClipboard()
      .read({ preferredTypes: ["text/plain"] })
      .then((result) => {
        if (!mounted.current || result.status !== "read") return;
        const text = new TextDecoder().decode(result.representation.bytes);
        if (text.length > 0) onText(text);
      })
      .catch(() => {});
  });
}
