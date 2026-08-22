/** @jsxImportSource @opentui/react */
// @opentui/react-version compat canary. Successor to this file's own former job (an
// ink-testing-library <-> Ink version-compat canary), retired along with `ink` itself -- there is
// nothing left for that canary to watch.
//
// The equivalent risk on this renderer: does the mock-input test harness
// (`createTestRenderer`'s `mockInput.pressKey`) actually drive a mounted component's
// `useKeyboard` subscription, against the SAME two-settled-render-pass `mount()` pattern every
// other keyboard-driving test in this suite (inputBox.test.tsx, inputThrottle.test.tsx,
// modelPicker.test.tsx, approvalBox.test.tsx, ...) already relies on? `useKeyboard`/`usePaste`
// subscribe from a plain (passive) `useEffect`, and the reconciler commits on a macrotask rather
// than a microtask -- the first settled pass only lands the initial commit; the passive effect
// that subscribes the keyboard handler runs during the second one.
//
// Deliberately NOT asserting the tighter "a press after only ONE settle is dropped" half of this
// (an earlier version of this file did): measured live, that assertion was order-dependent on
// which OTHER test files in this suite ran first in the same `bun test` process -- an undestroyed
// `CliRenderer` instance leaking into a later file shifts the exact settle count needed enough
// that a press after one settle sometimes DOES already register. Every file in this suite now
// destroys its own renderers (this one included, `afterEach` above), which narrows but does not
// eliminate the risk -- a future test file that skips that cleanup would silently reintroduce it.
// "Exactly one settle is too few" stays too fragile a thing for a permanent canary to assert for
// that reason. The direction of drift that would actually break every OTHER test in this suite --
// the double-settle `mount()` pattern silently stopping to be enough -- is exactly what this test
// still asserts, and does so reliably regardless of prior test-file ordering (unlike the dropped
// half).
//
// Kept permanently rather than deleted once this was answered: this is not a seri behavior test
// -- it is an upgrade canary. `@opentui/react` is pre-1.0 (spec risk table), so a point release
// changing this exact commit/subscribe timing is a real risk. If it drifts, this file should go
// red first, rather than being rediscovered by one of the larger tests going red for a reason
// unrelated to whatever it was actually testing.
import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot, useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";
import { useState } from "react";

// Destroying THIS file's own renderer doesn't change what the canary above asserts (that's about
// the two-settle mount() pattern, not this) — it only stops this file from being one of the
// undestroyed-renderer contributors the comment above names.
const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

function Probe() {
  const [lastKey, setLastKey] = useState("none");
  useKeyboard((key) => setLastKey(key.sequence));
  return <text>last: {lastKey}</text>;
}

async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  createRoot(setup.renderer).render(node);
  await settle(setup); // commits the mount
  await settle(setup); // lets passive effects (useKeyboard's useEffect) subscribe
}

describe("@opentui/react mock-input / useKeyboard wiring spike", () => {
  test("a keypress registers once the standard two-settle mount() pattern has let useKeyboard's effect subscribe", async () => {
    const setup = await createTestRenderer({ width: 30, height: 3 });
    mountedRenderers.push(setup);
    await mount(setup, <Probe />);

    setup.mockInput.pressKey("a");
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("last: a");
  });
});
