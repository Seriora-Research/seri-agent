/** @jsxImportSource @opentui/react */
// @opentui/react-version compat canary. Successor to this file's own former job (an
// ink-testing-library <-> Ink version-compat canary), retired along with `ink` itself -- there is
// nothing left for that canary to watch.
//
// The equivalent risk on this renderer: does the mock-input test harness
// (`createTestRenderer`'s `mockInput.pressKey`) actually drive a mounted component's
// `useKeyboard` subscription, and does it still take TWO total settled render passes after mount
// before that subscription exists? `useKeyboard`/`usePaste` subscribe from a plain (passive)
// `useEffect`, and the reconciler commits on a macrotask rather than a microtask -- the first
// settled pass only lands the initial commit; the passive effect that subscribes the keyboard
// handler runs during the second one. Measured directly against this harness: a keypress sent
// after only the first settle is silently dropped (confirmed by temporarily inserting an extra
// settle before that first press instead -- it then registers, so the boundary is exactly two
// total passes, not a timing coincidence).
//
// Kept permanently rather than deleted once this was answered: this is not a seri behavior test
// -- it is an upgrade canary. `@opentui/react` is pre-1.0 (spec risk table), so a point release
// changing this exact commit/subscribe timing is a real risk, and every other keyboard-driving
// test in this suite (inputBox.test.tsx, inputThrottle.test.tsx, modelPicker.test.tsx, ...)
// silently depends on the same double-settle behavior via their own `mount()` helpers. If it
// drifts, this file should go red first, with the measurement above still explaining what a
// failure means, rather than being rediscovered by one of those larger tests going red for a
// reason unrelated to whatever it was actually testing.
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, useKeyboard } from "@opentui/react";
import { useState } from "react";

function Probe() {
  const [lastKey, setLastKey] = useState("none");
  useKeyboard((key) => setLastKey(key.sequence));
  return <text>last: {lastKey}</text>;
}

async function settle(setup: { renderOnce: () => Promise<void> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

describe("@opentui/react mock-input / useKeyboard wiring spike", () => {
  test("a keypress only registers once a SECOND settled render pass has let useKeyboard's effect subscribe", async () => {
    const setup = await createTestRenderer({ width: 30, height: 3 });
    createRoot(setup.renderer).render(<Probe />);

    await settle(setup); // commits the mount; useKeyboard's passive effect hasn't run yet
    setup.mockInput.pressKey("a");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("last: none");

    setup.mockInput.pressKey("a");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("last: a");
  });
});
