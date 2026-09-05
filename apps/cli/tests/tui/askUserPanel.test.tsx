/** @jsxImportSource @opentui/react */

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import type { HumanReply } from "../../src/ask-user/types";
import { AskUserPanel } from "../../src/tui/components/AskUserPanel";

const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function waitUntil(
  setup: TestRendererSetup,
  pred: () => boolean,
  label: string,
  retry?: () => void,
): Promise<void> {
  const start = Date.now();
  const deadline = start + 1500;
  let retried = false;
  while (Date.now() < deadline) {
    if (pred()) return;
    if (retry !== undefined && !retried && Date.now() - start > 400) {
      retry();
      retried = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.renderOnce();
  }
  if (pred()) return;
  throw new Error(label);
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  mountedRenderers.push(setup);
  createRoot(setup.renderer).render(node);
  await settle(setup);
  await settle(setup);
}

const prompt = {
  prompt: "Which auth?",
  choices: ["cookies", "JWT"],
  allowOther: true,
};

describe("AskUserPanel", () => {
  test("renders the prompt and choices, not always or plan questions", async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    await mount(setup, <AskUserPanel prompt={prompt} onAnswer={() => {}} />);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("question");
    expect(frame).toContain("Which auth?");
    expect(frame).toContain("cookies");
    expect(frame).not.toContain("plan questions");
    expect(frame).not.toMatch(/\balways\b/i);
    expect(frame).not.toMatch(/\b\[Y\]es\b/);
  });

  test("Enter on the first choice answers picked", async () => {
    const answers: HumanReply[] = [];
    const setup = await createTestRenderer({ width: 60, height: 12 });
    await mount(setup, <AskUserPanel prompt={prompt} onAnswer={(a) => answers.push(a)} />);
    const press = () => setup.mockInput.pressEnter();
    press();
    await waitUntil(setup, () => answers.length > 0, "Enter never answered", press);
    expect(answers).toEqual([{ outcome: "picked", choice: "cookies" }]);
  });

  test("Enter on empty Other does not submit", async () => {
    const answers: HumanReply[] = [];
    const setup = await createTestRenderer({ width: 60, height: 12 });
    await mount(setup, <AskUserPanel prompt={prompt} onAnswer={(a) => answers.push(a)} />);
    setup.mockInput.pressArrow("up");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(answers).toEqual([]);
  });

  test("Escape answers cancelled", async () => {
    const answers: HumanReply[] = [];
    const setup = await createTestRenderer({ width: 60, height: 12 });
    await mount(setup, <AskUserPanel prompt={prompt} onAnswer={(a) => answers.push(a)} />);
    const press = () => setup.mockInput.pressKey("\x1b");
    press();
    await waitUntil(setup, () => answers.length > 0, "Escape never answered", press);
    expect(answers).toEqual([{ outcome: "cancelled" }]);
  });

  test("Ctrl-D calls onQuit, not onAnswer", async () => {
    const answers: HumanReply[] = [];
    let quit = false;
    const setup = await createTestRenderer({ width: 60, height: 12 });
    await mount(
      setup,
      <AskUserPanel
        prompt={prompt}
        onAnswer={(a) => answers.push(a)}
        onQuit={() => {
          quit = true;
        }}
      />,
    );
    const press = () => setup.mockInput.pressKey("d", { ctrl: true });
    press();
    await waitUntil(setup, () => quit, "Ctrl-D never called onQuit", press);
    expect(quit).toBe(true);
    expect(answers).toEqual([]);
  });
});
