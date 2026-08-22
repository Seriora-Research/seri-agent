/** @jsxImportSource @opentui/react */
// THROWAWAY SPIKE test — Phase 1 of docs/specs/025-tui-opentui-migration/tasks.md. Automated,
// programmatic evidence for the transcript-viewport half of the Phase 1 gate. Deleted along with
// the rest of _spike-phase1/ before Phase 2's real app.tsx rewrite starts.
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "../format";
import { MeasuredBox, ScrollboxTranscript, SlicedTranscript } from "./transcriptSpike";

// @opentui/react's reconciler commits on a real macrotask, not a microtask — calling
// renderer.loop()/flush() right after createRoot(...).render() can race that commit and capture
// a stale (blank) frame, confirmed empirically against this exact harness (a bare `await
// setup.flush()` with no yield first reliably captured 5 blank rows here). One `setTimeout(…, 0)`
// yield first is what the migration plan's own tasks.md/spec.md already flagged as a risk to
// verify, not assume ("async-tick timing may differ under OpenTUI's renderer").
async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

// 120 entries, alternating short user turns and multi-row-wrapping assistant replies — comparable
// order of magnitude to the 150-300 real visual rows the migration research's own spike used as
// "seri's real transcript scale" (docs/specs/025-tui-opentui-migration/research.md, Performance
// section), run here through format.ts's own real wrap/measure functions, not a re-implementation.
function buildRealScaleTranscript(): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let i = 0; i < 60; i++) {
    entries.push({ role: "user", text: `do the thing number ${i}` });
    entries.push({
      role: "assistant",
      text: `Sure — here is a longer assistant reply for turn ${i} that wraps across more than one visual row once it hits an 80-column terminal, the same way a real streamed answer does.`,
    });
  }
  return entries;
}

describe("Phase 1 spike: transcript viewport against format.ts's real wrap/measure output", () => {
  test("scrollbox stickyStart=bottom follows the real transcript's tail with no manual slice/offset math", async () => {
    const entries = buildRealScaleTranscript();
    const setup = await createTestRenderer({ width: 80, height: 24 });
    createRoot(setup.renderer).render(<ScrollboxTranscript entries={entries} columns={80} />);
    await settle(setup);
    const frame = setup.captureCharFrame();
    // The newest entry must be visible on first render with zero viewport-height input anywhere
    // in ScrollboxTranscript (compare to SlicedTranscript below, which needs one) — this is the
    // thing App.tsx's viewportRows/transcriptOffset computation exists to guarantee today.
    expect(frame).toContain("do the thing number 59");
  });

  test("a plain flexGrow box's onSizeChange fires with a real post-layout height/width — the useBoxMetrics equivalent", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const measured: { height: number; width: number }[] = [];
    createRoot(setup.renderer).render(
      <box flexDirection="column" height={23}>
        <MeasuredBox onMeasured={(height, width) => measured.push({ height, width })}>
          <text>content</text>
        </MeasuredBox>
        <box height={1}>
          <text>mode indicator</text>
        </box>
      </box>,
    );
    await settle(setup);
    expect(measured.length).toBeGreaterThan(0);
    const last = measured[measured.length - 1];
    // 23 rows total, minus the 1-row sibling below it — the same "flexbox leftover space" App.tsx's
    // own viewportRef box measures via useBoxMetrics today, read here via onSizeChange instead of
    // an effect polling a DOM-element ref.
    expect(last.height).toBe(22);
    expect(last.width).toBe(80);
  });

  test("SlicedTranscript (today's App.tsx shape) needs an externally supplied viewportRows to do the same job", async () => {
    const entries = buildRealScaleTranscript();
    const setup = await createTestRenderer({ width: 80, height: 24 });
    createRoot(setup.renderer).render(
      <SlicedTranscript entries={entries} columns={80} viewportRows={10} />,
    );
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("do the thing number 59");
  });
});
