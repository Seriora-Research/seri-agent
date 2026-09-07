// Bare Ctrl-V is not always a paste event; this reads the host OS clipboard beside `usePaste`, which is the wrong clipboard over SSH.
import { createHostClipboard, type HostClipboardService } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef } from "react";

let service: HostClipboardService | undefined;

function hostClipboard(): HostClipboardService {
  service ??= createHostClipboard();
  return service;
}

export function useClipboardPaste(onText: (text: string) => void): void {
  const mounted = useRef(true);
  useEffect(() => {
    // React StrictMode remounts without resetting this ref; set `mounted` true on enter or the hook stays dead.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "v") return;
    try {
      // `createHostClipboard` throws synchronously when no native clipboard exists (@opentui/core NativeClipboardBackend).
      void hostClipboard()
        .read({ preferredTypes: ["text/plain"] })
        .then((result) => {
          if (!mounted.current || result.status !== "read") return;
          // `preferredTypes` is a hint; a non-text MIME can still return `status: "read"`.
          if (!result.representation.mimeType.startsWith("text/")) return;
          const text = new TextDecoder().decode(result.representation.bytes);
          if (text.length > 0) onText(text);
        })
        .catch(() => {});
    } catch {}
  });
}
