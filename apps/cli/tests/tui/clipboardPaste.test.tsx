/** @jsxImportSource @opentui/react */
// hooks/useClipboardPaste.ts — Ctrl-V on the four surfaces that can take text. Bracketed paste
// (`usePaste`) covers the terminal's OWN paste action and is tested through each component's own
// suite; this covers the other half, which no terminal turns into a paste event and which
// therefore reads the OS clipboard itself.
//
// `createHostClipboard` is faked at the module boundary rather than driven for real: the real one
// is an FFI call into the platform clipboard, so a real round trip would clobber whatever the
// person running the suite had copied, and would report "unsupported" on a headless Linux CI
// runner that has neither Wayland nor X11 — a test that silently skips on one of the three
// platforms CI runs is not a regression guard. The seam is worth faking and nothing below it is:
// that the native read reaches the real OS clipboard is opentui's claim, measured separately by
// `.claude/skills/verify-seri/scripts/probe-clipboard.mjs`.

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as opentuiCore from "@opentui/core";

// What the next `read()` resolves (or rejects) with. Mutable because the fake service is created
// once, by the hook's own module-level cache, and outlives every individual test here.
let nextRead: () => Promise<unknown> = async () => ({ status: "empty" });
let readCount = 0;
// The factory's own two knobs: `createThrows` reproduces the real one's synchronous throw, and
// `createCount` is what keeps the test that uses it from going vacuous (see it for why).
let createThrows = false;
let createCount = 0;

mock.module("@opentui/core", () => ({
  ...opentuiCore,
  createHostClipboard: () => {
    createCount++;
    if (createThrows) throw new Error("Failed to create native clipboard service");
    return {
      maxWriteBytes: 1024,
      read: () => {
        readCount++;
        return nextRead();
      },
      writeText: async () => ({ status: "written" }),
      clear: async () => ({ status: "cleared" }),
      dispose: async () => {},
    };
  },
}));

// Imported after the mock is installed, the order bun's own module mocking asks for.
const { createTestRenderer } = await import("@opentui/core/testing");
const { createRoot } = await import("@opentui/react");
const { InputBox } = await import("../../src/tui/components/InputBox");
const { ModelPicker } = await import("../../src/tui/components/ModelPicker");
const { ConfigPanel } = await import("../../src/tui/routes/config/ConfigPanel");

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

function clipboardHolding(text: string): () => Promise<unknown> {
  return async () => ({
    status: "read",
    representation: { mimeType: "text/plain", bytes: new TextEncoder().encode(text) },
  });
}

const mountedRenderers: Setup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
  nextRead = async () => ({ status: "empty" });
  readCount = 0;
  createThrows = false;
  createCount = 0;
});

// Two settled passes, the same shape helpers.ts's own `flush` uses and for the same reason: a
// freshly mounted `useKeyboard` does not subscribe until the second one.
async function flush(setup: Setup): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup.renderOnce();
  }
}

// The read is async by design (the hook's own comment: blocking the keypress path on the OS would
// stall every other handler), so the frame it lands in is one the caller has to wait for rather
// than one `flush` alone reaches. Polls the caller's own completion signal on a real interval, the
// same technique `flushMarkdown` uses, instead of guessing a fixed sleep.
async function flushClipboard(setup: Setup, isSettled: (frame: string) => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.renderOnce();
    if (isSettled(setup.captureCharFrame())) return;
  }
  throw new Error("flushClipboard: the pasted text never appeared within 3000ms");
}

async function mount(node: React.ReactNode, width = 80, height = 12): Promise<Setup> {
  const setup = await createTestRenderer({ width, height });
  mountedRenderers.push(setup);
  createRoot(setup.renderer).render(node);
  await flush(setup);
  return setup;
}

describe("Ctrl-V", () => {
  // The construction half of "do not let the clipboard take the session down"; the read half is the
  // last test in this file. @opentui/core 0.5.6's own `new NativeClipboardBackend(...)` throws
  // "Failed to create native clipboard service" SYNCHRONOUSLY when there is no platform clipboard
  // to reach — a headless box, an SSH session, a Linux runner with neither Wayland nor X11 — and
  // the hook's `.catch` covers only the async half, so that throw leaves the hook entirely.
  //
  // `console.error` is the assertion, because nothing louder happens: OpenTUI's own
  // `KeyHandler.emitWithPriority` wraps every registered listener in a catch, logs what it caught
  // and carries on to the next one, so an unguarded throw never reaches the process and every other
  // assertion below passes either way. What the guard buys is that this hook answers for its own
  // failure instead of leaving a dependency to log a stack trace into the renderer's console on
  // every press.
  //
  // First in this file deliberately, because the hook caches one service for the whole process
  // (`service ??= createHostClipboard()`) and only calls the factory again after a call that threw
  // — from any later position the cached fake would answer and this would pass without testing
  // anything. `createCount` is asserted so that reordering fails the test instead of hollowing it.
  test("a clipboard service that throws on construction is handled inside the hook", async () => {
    createThrows = true;
    const setup = await mount(<InputBox onSubmit={() => {}} />);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    // Read inside the `try`, not after it: `mockRestore` clears the call record along with the
    // implementation, so a check made after it reports zero calls whatever happened.
    let logged: string[] = [];
    try {
      setup.mockInput.pressKey("v", { ctrl: true });
      await flush(setup);
      logged = consoleError.mock.calls.map((args) => String(args[0]));
    } finally {
      consoleError.mockRestore();
    }

    expect(createCount).toBe(1);
    expect(logged).toEqual([]);
    expect(readCount).toBe(0);
    // Survived is not enough: the surface has to still work afterwards, since the press is one the
    // user will make again. The wait is InputBox's own 50ms keystroke-coalescing window — without
    // it only the leading character has been painted.
    await setup.mockInput.typeText("still typing");
    await new Promise((resolve) => setTimeout(resolve, 70));
    await flush(setup);
    expect(setup.captureCharFrame()).toContain("still typing");
  });

  test("inserts the OS clipboard's text into the input box", async () => {
    nextRead = clipboardHolding("apps/cli/src/tui/app.tsx");
    const setup = await mount(<InputBox onSubmit={() => {}} />);

    setup.mockInput.pressKey("v", { ctrl: true });
    await flushClipboard(setup, (frame) => frame.includes("apps/cli/src/tui/app.tsx"));

    // Pins the binding itself, not just the insertion: if `key.ctrl` stopped being reported for
    // this chord, or the name stopped being "v", the read would never be attempted at all and the
    // failure above would look identical to a broken insert.
    expect(readCount).toBe(1);
  });

  test("appends at the cursor rather than replacing what is already typed", async () => {
    nextRead = clipboardHolding("world");
    const setup = await mount(<InputBox onSubmit={() => {}} />);

    await setup.mockInput.typeText("hello ");
    await flush(setup);
    setup.mockInput.pressKey("v", { ctrl: true });
    await flushClipboard(setup, (frame) => frame.includes("hello world"));
  });

  test("a clipboard holding a newline submits what is before it and keeps the rest", async () => {
    // The rule bracketed paste already follows (util/keys.ts's `splitAtTerminator`). Asserted for
    // this path too because the two feed one shared insert: if they were ever split into separate
    // bodies, a Ctrl-V of the same text would start behaving differently from a right-click paste
    // of it, which is the drift the shared function exists to prevent.
    nextRead = clipboardHolding("run this\r\nand keep this");
    const submitted: string[] = [];
    const setup = await mount(<InputBox onSubmit={(value) => submitted.push(value)} />);

    setup.mockInput.pressKey("v", { ctrl: true });
    await flushClipboard(setup, (frame) => frame.includes("and keep this"));

    expect(submitted).toEqual(["run this"]);
  });

  test("narrows the model picker's filter", async () => {
    nextRead = clipboardHolding("llama");
    const setup = await mount(
      <ModelPicker
        entries={[
          {
            entry: {
              id: "llama-3.3-70b",
              provider: "groq",
              displayName: "Llama 3.3 70B",
              family: "llama",
              contextWindow: 131_072,
              maxOutputTokens: 32_768,
              toolCall: true,
              reasoning: false,
              pricing: undefined,
            },
            keyConfigured: true,
            alternatives: 0,
            gatewayReachable: false,
          },
        ]}
      />,
    );

    setup.mockInput.pressKey("v", { ctrl: true });
    await flushClipboard(setup, (frame) => frame.includes("llama"));
  });

  test("fills a config value, with the newlines a copied key drags along stripped", async () => {
    // ConfigPanel and SetupPanel strip terminators instead of splitting on them (a pasted
    // credential is never meant to submit itself), so this is the other of the two insert rules —
    // and the masked render is what proves the value landed without showing the secret.
    nextRead = clipboardHolding("sk-test-value\n");
    const setup = await mount(
      <ConfigPanel
        pendingConfig={{ step: "enter-value", key: "SERI_SOME_OTHER_KEY", busy: false }}
      />,
    );

    setup.mockInput.pressKey("v", { ctrl: true });
    await flushClipboard(setup, (frame) => frame.includes("*".repeat(13)));

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("sk-test-value");
    // 13 stars, not 14: the trailing newline is stripped rather than stored as a character.
    expect(frame).not.toContain("*".repeat(14));
  });

  test("a representation that is not text is not decoded into the surface", async () => {
    // `preferredTypes: ["text/plain"]` is a preference the backend is free to decline, not a
    // filter, and it reports a picked-something-else answer as `status: "read"` like any other —
    // so a clipboard holding only an image hands back PNG bytes, and decoding them as UTF-8 types
    // the file's own magic number into whichever surface has focus.
    // The signature's first four bytes only: its next two are CR LF, and a paste carrying a
    // terminator submits the line before it (`splitAtTerminator`) — which would clear the box and
    // hide the mojibake this is looking for.
    nextRead = async () => ({
      status: "read",
      representation: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    });
    const setup = await mount(<InputBox onSubmit={() => {}} />);

    setup.mockInput.pressKey("v", { ctrl: true });
    await flush(setup);
    await new Promise((resolve) => setTimeout(resolve, 70));
    await flush(setup);

    // `readCount`, so this cannot pass by the read never having happened at all.
    expect(readCount).toBe(1);
    expect(setup.captureCharFrame()).not.toContain("PNG");
  });

  test("a read that lands after the surface is gone is dropped, and a failing one is survived", async () => {
    // Both halves of "do not let an async clipboard take the session down". The surface unmounts
    // between the keypress and the result on every real panel swap — answering an approval, closing
    // /config — because each of the four is a branch of app.tsx's own render ternary.
    let release: (() => void) | undefined;
    const late = clipboardHolding("late");
    nextRead = () =>
      new Promise((resolve) => {
        release = () => resolve(late());
      });
    const setup = await mount(<InputBox onSubmit={() => {}} />);
    setup.mockInput.pressKey("v", { ctrl: true });
    await flush(setup);

    setup.renderer.destroy();
    mountedRenderers.splice(mountedRenderers.indexOf(setup), 1);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A rejection is the other way this could reach the process: `read` reports every expected
    // failure as a `status`, so a throw is unforeseen by definition — and an unhandled one would
    // reach runtime/renderer.ts's own `unhandledRejection` handler, which exits.
    nextRead = () => Promise.reject(new Error("clipboard exploded"));
    const second = await mount(<InputBox onSubmit={() => {}} />);
    second.mockInput.pressKey("v", { ctrl: true });
    await flush(second);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(second.captureCharFrame()).toContain(">");
  });
});
