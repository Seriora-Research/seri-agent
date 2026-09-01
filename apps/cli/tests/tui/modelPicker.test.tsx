/** @jsxImportSource @opentui/react */
// ModelPicker.tsx (apps/cli/src/tui/components/ModelPicker.tsx), the OpenTUI port of the old
// panels/ModelPicker.tsx. Mirrors inputBox.test.tsx's own harness (settle/mount). Also the
// re-test site for the documented Yoga flexShrink arbitration bug (ModelPicker.tsx's own filter-row
// comment): a bare `<text>` cursor sibling (not wrapped in its own `<box>`) reliably keeps its own
// space at every terminal width tried here, so the manual JS truncation workaround from the Ink
// version is not carried over.

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { ReactNode } from "react";
import type { ModelPickerEntry } from "../../src/tui/state/commands";
import { ModelPicker } from "../../src/tui/components/ModelPicker";

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
    // A bare ESC byte is ambiguous with the start of every other escape sequence (arrow keys,
    // etc.) — the parser waits out its own 20ms disambiguation timeout before emitting it as a
    // standalone "escape" keypress, unlike an already-unambiguous multi-byte sequence.
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

  // Re-test of the Ink-side Yoga flexShrink arbitration bug (documented in ModelPicker.tsx's own
  // filter-row comment): the cursor must remain visible at every width, even once the filter query
  // and the row content can no longer all fit on one line.
  for (const width of [80, 43, 42, 30, 20]) {
    test(`cursor stays visible at width ${width} with a long filter query`, async () => {
      const setup = await createTestRenderer({ width, height: 10 });
      await mountPicker(setup, () => {});

      await setup.mockInput.typeText("x".repeat(60));
      await settle(setup);

      // The cursor renders as a reverse-video single space — captureCharFrame() returns plain
      // characters, so this only asserts the row didn't go blank (the actual bug's symptom: the
      // whole line, including the "> " prompt, vanished) rather than the space's own styling.
      const frame = setup.captureCharFrame();
      expect(frame).toContain(">");
    });
  }

  test("at 80 columns a row with +1 route still shows intact Context and Cost", async () => {
    const rows: ModelPickerEntry[] = [{
      entry: {
        id: "openai/gpt-oss-120b",
        displayName: "GPT OSS 120B",
        provider: "groq",
        family: "gpt-oss",
        contextWindow: 131_072,
        maxOutputTokens: 32_768,
        toolCall: true,
        reasoning: false,
        pricing: { inputPerMTok: 0.15, outputPerMTok: 0.60 },
      },
      keyConfigured: true,
      alternatives: 1,
      gatewayReachable: false,
    }];
    const setup = await createTestRenderer({ width: 80, height: 10 });
    await mountPicker(setup, () => {}, undefined, rows);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("128K");
    expect(frame).toContain("$0.15/$0.60");
  });

  // Re-test of ui/ListRow.tsx's own truncate-with-multiple-children bug (see that file's comment):
  // a selectable row whose label overflows the terminal width must still render, not go blank.
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
