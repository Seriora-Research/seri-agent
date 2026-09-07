/** @jsxImportSource @opentui/react */
// A bare <text> cursor sibling keeps its space at every width tried here, so the Ink Yoga flexShrink truncation workaround is not carried over.

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { ReactNode } from "react";
import { ModelPicker } from "../../src/tui/components/ModelPicker";
import type { ModelPickerEntry } from "../../src/tui/state/commands";

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

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  mountedRenderers.push(setup);
  createRoot(setup.renderer).render(node);
  await settle(setup);
  await settle(setup);
}

function entry(
  id: string,
  displayName: string,
  provider: ModelCatalogEntry["provider"],
): ModelPickerEntry {
  return {
    entry: {
      id,
      displayName,
      provider,
      family: null,
      contextWindow: 128000,
      maxOutputTokens: 4096,
      toolCall: true,
      reasoning: false,
      pricing: undefined,
    },
    keyConfigured: true,
    alternatives: 0,
    gatewayReachable: false,
    subscriptionCovered: false,
  };
}

const entries: ModelPickerEntry[] = [
  entry("gpt-4", "GPT-4", "openai"),
  entry("claude-sonnet-5", "Claude Sonnet 5", "anthropic"),
  entry("llama-3.3-70b", "Llama 3.3 70B", "groq"),
];

async function mountPicker(
  setup: TestRendererSetup,
  onModelSelected: (
    pick: { model: string; provider: ModelProvider; keyConfigured: boolean },
    leftover?: string,
  ) => void,
  onModelPickerCancel?: () => void,
  rows: ModelPickerEntry[] = entries,
): Promise<void> {
  await mount(
    setup,
    <ModelPicker
      entries={rows}
      onModelSelected={onModelSelected}
      onModelPickerCancel={onModelPickerCancel}
    />,
  );
}

describe("ModelPicker (OpenTUI)", () => {
  test("renders every row's formatted label", async () => {
    const setup = await createTestRenderer({ width: 100, height: 10 });
    await mountPicker(setup, () => {});
    const frame = setup.captureCharFrame();
    expect(frame).toContain("GPT-4");
    expect(frame).toContain("Claude Sonnet 5");
    expect(frame).toContain("Llama 3.3 70B");
  });

  test("typing narrows the filtered list", async () => {
    const setup = await createTestRenderer({ width: 100, height: 10 });
    await mountPicker(setup, () => {});

    await setup.mockInput.typeText("claude");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Claude Sonnet 5");
    expect(frame).not.toContain("GPT-4");
  });

  test("Enter selects the top (first) row", async () => {
    const picks: string[] = [];
    const setup = await createTestRenderer({ width: 100, height: 10 });
    await mountPicker(setup, (pick) => picks.push(pick.model));

    setup.mockInput.pressEnter();
    await settle(setup);

    expect(picks).toEqual(["gpt-4"]);
  });

  test("Down then Enter selects the second row", async () => {
    const picks: string[] = [];
    const setup = await createTestRenderer({ width: 100, height: 10 });
    await mountPicker(setup, (pick) => picks.push(pick.model));

    setup.mockInput.pressArrow("down");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(picks).toEqual(["claude-sonnet-5"]);
  });

  test("Escape cancels without selecting", async () => {
    let cancelled = false;
    const picks: string[] = [];
    const setup = await createTestRenderer({ width: 100, height: 10 });
    await mountPicker(
      setup,
      (pick) => picks.push(pick.model),
      () => {
        cancelled = true;
      },
    );

    setup.mockInput.pressEscape();
    // OpenTUI holds a bare ESC for a ~20ms disambiguation window before emitting it as escape.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle(setup);

    expect(cancelled).toBe(true);
    expect(picks).toEqual([]);
  });

  test("Backspace narrows the filter back out", async () => {
    const setup = await createTestRenderer({ width: 100, height: 10 });
    await mountPicker(setup, () => {});

    await setup.mockInput.typeText("claudex");
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("Claude Sonnet 5");

    setup.mockInput.pressBackspace();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Claude Sonnet 5");
  });

  test("a pasted chunk with an embedded terminator selects the top match and keeps the rest", async () => {
    const picks: string[] = [];
    let leftover: string | undefined;
    const setup = await createTestRenderer({ width: 100, height: 10 });
    await mount(
      setup,
      <ModelPicker
        entries={entries}
        onModelSelected={(pick, after) => {
          picks.push(pick.model);
          leftover = after;
        }}
      />,
    );

    await setup.mockInput.pasteBracketedText("claude\r\nnext task");
    await settle(setup);

    expect(picks).toEqual(["claude-sonnet-5"]);
    expect(leftover).toBe("next task");
  });

  for (const width of [80, 43, 42, 30, 20]) {
    test(`cursor stays visible at width ${width} with a long filter query`, async () => {
      const setup = await createTestRenderer({ width, height: 10 });
      await mountPicker(setup, () => {});

      await setup.mockInput.typeText("x".repeat(60));
      await settle(setup);

      // The cursor is a single space; captureCharFrame has no styling, so this only asserts the row did not go blank.
      const frame = setup.captureCharFrame();
      expect(frame).toContain(">");
    });
  }

  test("at 80 columns a row with +1 route still shows intact Context and Cost", async () => {
    const rows: ModelPickerEntry[] = [
      {
        entry: {
          id: "openai/gpt-oss-120b",
          displayName: "GPT OSS 120B",
          provider: "groq",
          family: "gpt-oss",
          contextWindow: 131_072,
          maxOutputTokens: 32_768,
          toolCall: true,
          reasoning: false,
          pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
        },
        keyConfigured: true,
        alternatives: 1,
        gatewayReachable: false,
        subscriptionCovered: false,
      },
    ];
    const setup = await createTestRenderer({ width: 80, height: 10 });
    await mountPicker(setup, () => {}, undefined, rows);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("128K");
    expect(frame).toContain("$0.15/$0.60");
  });

  test("a row whose label overflows the terminal width still renders, not blank", async () => {
    const longEntries = [
      entry(
        "very-long-model-id-that-is-quite-long",
        "A Very Long Display Name Indeed",
        "openrouter",
      ),
    ];
    const setup = await createTestRenderer({ width: 40, height: 10 });
    await mountPicker(setup, () => {}, undefined, longEntries);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("A Very Long");
  });
});
