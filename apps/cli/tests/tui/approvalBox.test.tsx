/** @jsxImportSource @opentui/react */
// ApprovalBox.tsx (apps/cli/src/tui/components/ApprovalBox.tsx), the OpenTUI port of the old
// panels/ApprovalBox.tsx. Mirrors inputBox.test.tsx's own harness (settle/mount) and its own
// finding: @opentui/react's reconciler needs a second settled render pass after mount before
// useKeyboard's subscription is live.

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import type { ApprovalAnswer } from "../../src/loop/loop";
import { ApprovalBox } from "../../src/tui/components/ApprovalBox";

// Each `createTestRenderer()` call registers its own listener on the process-wide
// `TerminalConsoleCache` singleton (see App.test.tsx's own comment on this) — leaking it across
// test FILES within one bun test process causes order-dependent flakiness. `afterEach` destroys
// whatever this file's own tests created.
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

// One settle after pressEnter can return before useKeyboard delivers the key, so `answers`
// stays []. Poll a macrotick instead of a fixed pass count. OpenTUI's waitFor is the wrong
// helper: it stops when the scheduler reports idle, which can happen before the handler runs.
async function waitUntil(
  setup: TestRendererSetup,
  pred: () => boolean,
  label: string,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await settle(setup);
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

const pendingApproval = { toolName: "write_file", args: { path: "a.txt" }, offersAlways: true };

async function mountBox(
  setup: TestRendererSetup,
  onAnswer: (answer: ApprovalAnswer) => void,
  onQuit?: () => void,
  offersAlways = true,
): Promise<void> {
  await mount(
    setup,
    <ApprovalBox
      pendingApproval={{ ...pendingApproval, offersAlways }}
      onAnswer={onAnswer}
      onQuit={onQuit}
    />,
  );
}

describe("ApprovalBox (OpenTUI)", () => {
  test("renders the approval prompt text", async () => {
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, () => {});
    expect(setup.captureCharFrame()).toContain("write_file");
  });

  test("'y' answers once", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    setup.mockInput.pressKey("y");
    await waitUntil(setup, () => answers.length > 0, "y never answered");

    expect(answers).toEqual(["once"]);
  });

  test("'a' answers always when offered", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    setup.mockInput.pressKey("a");
    await waitUntil(setup, () => answers.length > 0, "a never answered");

    expect(answers).toEqual(["always"]);
  });

  test("'a' falls through to 'no' when always is not offered", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a), undefined, false);

    setup.mockInput.pressKey("a");
    await waitUntil(setup, () => answers.length > 0, "a never answered");

    expect(answers).toEqual(["no"]);
  });

  test("Enter defaults to 'no'", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    setup.mockInput.pressEnter();
    await waitUntil(setup, () => answers.length > 0, "Enter never answered");

    expect(answers).toEqual(["no"]);
  });

  test("any other typed key answers 'no'", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    setup.mockInput.pressKey("z");
    await waitUntil(setup, () => answers.length > 0, "z never answered");

    expect(answers).toEqual(["no"]);
  });

  test("an arrow key is inert, not answered as 'no'", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    setup.mockInput.pressArrow("up");
    await settle(setup);

    expect(answers).toEqual([]);
  });

  test("Ctrl-D calls onQuit, not onAnswer", async () => {
    const answers: ApprovalAnswer[] = [];
    let quit = false;
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(
      setup,
      (a) => answers.push(a),
      () => {
        quit = true;
      },
    );

    setup.mockInput.pressKey("d", { ctrl: true });
    await waitUntil(setup, () => quit, "Ctrl-D never called onQuit");

    expect(quit).toBe(true);
    expect(answers).toEqual([]);
  });
});
