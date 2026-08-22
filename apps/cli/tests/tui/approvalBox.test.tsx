/** @jsxImportSource @opentui/react */
// ApprovalBox.tsx (apps/cli/src/tui/components/ApprovalBox.tsx), the OpenTUI port of the old
// panels/ApprovalBox.tsx. Mirrors inputBox.test.tsx's own harness (settle/mount) and its own
// finding: @opentui/react's reconciler needs a second settled render pass after mount before
// useKeyboard's subscription is live.

import { describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import type { ApprovalAnswer } from "../../src/loop/loop";
import { ApprovalBox } from "../../src/tui/components/ApprovalBox";

async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
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
    await settle(setup);

    expect(answers).toEqual(["once"]);
  });

  test("'a' answers always when offered", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    setup.mockInput.pressKey("a");
    await settle(setup);

    expect(answers).toEqual(["always"]);
  });

  test("'a' falls through to 'no' when always is not offered", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a), undefined, false);

    setup.mockInput.pressKey("a");
    await settle(setup);

    expect(answers).toEqual(["no"]);
  });

  test("Enter defaults to 'no'", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    setup.mockInput.pressEnter();
    await settle(setup);

    expect(answers).toEqual(["no"]);
  });

  test("any other typed key answers 'no'", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    setup.mockInput.pressKey("z");
    await settle(setup);

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
    await settle(setup);

    expect(quit).toBe(true);
    expect(answers).toEqual([]);
  });
});
