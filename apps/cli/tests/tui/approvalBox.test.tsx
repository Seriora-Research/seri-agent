/** @jsxImportSource @opentui/react */
// @opentui/react needs a second settled pass after mount before useKeyboard is live.

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import type { ApprovalAnswer } from "../../src/loop/loop";
import { ApprovalBox } from "../../src/tui/components/ApprovalBox";

// createTestRenderer registers on the process-wide TerminalConsoleCache singleton; an undestroyed CliRenderer flakes later files in the same bun process.
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

// On loaded macOS CI, 50 zero-delay passes finish in ~90ms before useKeyboard has subscribed; OpenTUI waitFor stops at scheduler idle, so this polls 20ms and retries the press after 400ms.
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
    expect(setup.captureCharFrame()).toContain("Write a.txt?");
  });

  test("an edit approval paints oldString/newString hunks", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    await mount(
      setup,
      <ApprovalBox
        pendingApproval={{
          toolName: "edit",
          args: { oldString: "old", newString: "new" },
          offersAlways: true,
        }}
        onAnswer={() => {}}
      />,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Approve edit?");
    expect(frame).toContain("- old");
    expect(frame).toContain("+ new");
  });

  test("a write_file approval does not invent an all-adds hunk", async () => {
    const setup = await createTestRenderer({ width: 60, height: 8 });
    await mount(
      setup,
      <ApprovalBox
        pendingApproval={{
          toolName: "write_file",
          args: { path: "a.txt", content: "brand-new-body" },
          offersAlways: true,
        }}
        onAnswer={() => {}}
      />,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Write a.txt?");
    expect(frame).not.toContain("brand-new-body");
    expect(frame).not.toContain("+ brand-new-body");
  });

  test("'y' answers once", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    const press = () => setup.mockInput.pressKey("y");
    press();
    await waitUntil(setup, () => answers.length > 0, "y never answered", press);

    expect(answers).toEqual(["once"]);
  });

  test("'a' answers always when offered", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    const press = () => setup.mockInput.pressKey("a");
    press();
    await waitUntil(setup, () => answers.length > 0, "a never answered", press);

    expect(answers).toEqual(["always"]);
  });

  test("'a' falls through to 'no' when always is not offered", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a), undefined, false);

    const press = () => setup.mockInput.pressKey("a");
    press();
    await waitUntil(setup, () => answers.length > 0, "a never answered", press);

    expect(answers).toEqual(["no"]);
  });

  test("Enter defaults to 'no'", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    const press = () => setup.mockInput.pressEnter();
    press();
    await waitUntil(setup, () => answers.length > 0, "Enter never answered", press);

    expect(answers).toEqual(["no"]);
  });

  test("any other typed key answers 'no'", async () => {
    const answers: ApprovalAnswer[] = [];
    const setup = await createTestRenderer({ width: 60, height: 5 });
    await mountBox(setup, (a) => answers.push(a));

    const press = () => setup.mockInput.pressKey("z");
    press();
    await waitUntil(setup, () => answers.length > 0, "z never answered", press);

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

    const press = () => setup.mockInput.pressKey("d", { ctrl: true });
    press();
    await waitUntil(setup, () => quit, "Ctrl-D never called onQuit", press);

    expect(quit).toBe(true);
    expect(answers).toEqual([]);
  });
});
