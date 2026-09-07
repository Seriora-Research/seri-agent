/** @jsxImportSource @opentui/react */
// createHostClipboard is FFI into the OS clipboard; a real read would clobber the developer paste buffer and skip on headless Linux CI with neither Wayland nor X11.

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as opentuiCore from "@opentui/core";

let nextRead: () => Promise<unknown> = async () => ({ status: "empty" });
let readCount = 0;
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

// @opentui/react commits on a macrotask; a fresh useKeyboard does not subscribe until the second pass.
async function flush(setup: Setup): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup.renderOnce();
  }
}

// The clipboard read is async, so this polls the frame text on a real interval the way flushMarkdown does.
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
  // @opentui/core 0.5.6 NativeClipboardBackend throws synchronously when there is no platform clipboard, and KeyHandler.emitWithPriority swallows it so only a console.error spy can see an unguarded throw.
  test("a clipboard service that throws on construction is handled inside the hook", async () => {
    createThrows = true;
    const setup = await mount(<InputBox onSubmit={() => {}} />);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    // Read inside the try: mockRestore clears the call record with the implementation.
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
    // InputBox's 50ms coalescing window: without it only the leading character has been painted.
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
            subscriptionCovered: false,
          },
        ]}
      />,
    );

    setup.mockInput.pressKey("v", { ctrl: true });
    await flushClipboard(setup, (frame) => frame.includes("llama"));
  });

  test("fills a config value, with the newlines a copied key drags along stripped", async () => {
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
    // preferredTypes is a preference the backend may decline; PNG bytes decoded as UTF-8 type "PNG", and bytes after those four are CR LF which would submit and hide the mojibake.
    nextRead = async () => ({
      status: "read",
      representation: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    });
    const setup = await mount(<InputBox onSubmit={() => {}} />);

    setup.mockInput.pressKey("v", { ctrl: true });
    await flush(setup);
    await new Promise((resolve) => setTimeout(resolve, 70));
    await flush(setup);

    expect(readCount).toBe(1);
    expect(setup.captureCharFrame()).not.toContain("PNG");
  });

  test("a read that lands after the surface is gone is dropped, and a failing one is survived", async () => {
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

    nextRead = () => Promise.reject(new Error("clipboard exploded"));
    const second = await mount(<InputBox onSubmit={() => {}} />);
    second.mockInput.pressKey("v", { ctrl: true });
    await flush(second);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(second.captureCharFrame()).toContain(">");
  });
});
