// Phase 3 spike (feature-plan.md): does ink-testing-library's stdin.write() actually drive
// useInput under Ink 7? The library only declares Ink 5 support and its own issue #29 reports
// stdin.write() not driving useInput even on Ink 5 — this test is the empirical answer for Ink 7,
// not an assumption.
//
// Result: PASS, with a caveat. A synchronous assertion right after write() sees the OLD frame —
// measured, not assumed: Ink's useInput handler runs inside React's discreteUpdates (use-input.js),
// which under React 19 settles on a microtask, not synchronously. Two `await Promise.resolve()`
// ticks (cheaper and more precise than an arbitrary setTimeout) are enough for lastFrame() to
// reflect the update. So the library DOES wire input correctly under Ink 7 — a caller just has to
// await a tick before reading lastFrame(), same as asserting on any other React state update.
// Phase 4's input-driven component tests use ink-testing-library on this basis; no bespoke harness
// needed.
import { describe, expect, test } from "bun:test";
import { Text, useInput } from "ink";
import { render } from "ink-testing-library";
import { useState } from "react";

function Probe() {
  const [lastInput, setLastInput] = useState("");
  useInput((input) => setLastInput(input));
  return <Text>last: {lastInput || "none"}</Text>;
}

describe("ink-testing-library / Ink 7 input spike", () => {
  test("stdin.write() drives useInput once the microtask queue settles", async () => {
    const instance = render(<Probe />);

    expect(instance.lastFrame()).toBe("last: none");
    instance.stdin.write("a");
    await Promise.resolve();
    await Promise.resolve();
    expect(instance.lastFrame()).toBe("last: a");

    instance.unmount();
  });
});
