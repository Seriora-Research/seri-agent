/** @jsxImportSource @opentui/react */
// THROWAWAY SPIKE — Phase 1. Not an assertion-bearing test; prints real captured char-frames to
// stdout as manual/visual evidence for the PR-description findings (this environment has no real
// interactive TTY to type into by hand, so this is the closest available substitute: driving the
// exact same mockInput/renderer path a human session would use, and printing what it produced).
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { describe, test } from "bun:test";
import type { TranscriptEntry } from "../format";
import { HandRolledInputSpike, NativeInputSpike } from "./inputSpike";
import { ScrollboxTranscript } from "./transcriptSpike";

async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

function buildRealScaleTranscript(): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let i = 0; i < 10; i++) {
    entries.push({ role: "user", text: `turn ${i}` });
    entries.push({ role: "assistant", text: `reply ${i}` });
  }
  return entries;
}

describe("visual evidence (printed, not asserted)", () => {
  test("scrollbox transcript frame", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    createRoot(setup.renderer).render(
      <ScrollboxTranscript entries={buildRealScaleTranscript()} columns={40} />,
    );
    await settle(setup);
    console.log("\n--- ScrollboxTranscript frame ---\n" + setup.captureCharFrame());
  });

  test("native <input> after paste with embedded CRLF", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    createRoot(setup.renderer).render(<NativeInputSpike />);
    await settle(setup);
    await settle(setup);
    await setup.mockInput.pasteBracketedText("first line\r\nsecond line");
    await settle(setup);
    console.log("\n--- NativeInputSpike frame after paste ---\n" + setup.captureCharFrame());
  });

  test("hand-rolled input frame after paste with embedded CRLF", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    createRoot(setup.renderer).render(<HandRolledInputSpike />);
    await settle(setup);
    await settle(setup);
    await setup.mockInput.pasteBracketedText("first line\r\nsecond line");
    await settle(setup);
    console.log("\n--- HandRolledInputSpike frame after paste ---\n" + setup.captureCharFrame());
  });
});
