import { describe, expect, test } from "bun:test";
import { checkPermission } from "../../src/gate/gate";
import { decideFsPolicy, reduceConsent, type PolicyFact } from "../../src/gate/fsBoundary";

function fact(overrides: Partial<PolicyFact> = {}): PolicyFact {
  return {
    mode: "auto",
    toolClass: "read",
    location: "outside",
    consent: "unasked",
    standingDeny: false,
    hasPrompt: true,
    ...overrides,
  };
}

describe("checkPermission remains name-only", () => {
  test("read_file is allow in every mode, with no path argument to pass", () => {
    expect(checkPermission("read_file", "auto")).toBe("allow");
    expect(checkPermission("read_file", "approve-each")).toBe("allow");
    expect(checkPermission("read_file", "read-only")).toBe("allow");
  });
});

describe("decideFsPolicy", () => {
  test("inside and nopath keep the name gate", () => {
    expect(decideFsPolicy(fact({ location: "inside" }))).toBe("name-gate");
    expect(decideFsPolicy(fact({ location: "nopath", toolClass: "write" }))).toBe("name-gate");
  });

  test("auto, first outside read, live prompt: ask once", () => {
    expect(decideFsPolicy(fact())).toBe("ask");
  });

  test("a dummy prompt is not a live human: noprompt blocks an outside read", () => {
    expect(decideFsPolicy(fact({ hasPrompt: false }))).toBe("block");
    expect(decideFsPolicy(fact({ mode: "approve-each", hasPrompt: false }))).toBe("block");
    expect(decideFsPolicy(fact({ mode: "read-only", hasPrompt: false }))).toBe("block");
  });

  test("write + approve-each still asks, so a persisted grant cannot skip the folder question", () => {
    expect(
      decideFsPolicy(fact({ toolClass: "write", mode: "approve-each", hasPrompt: true })),
    ).toBe("ask");
  });

  test("write + auto asks when a human is present and blocks when they are not", () => {
    expect(decideFsPolicy(fact({ toolClass: "write", mode: "auto", hasPrompt: true }))).toBe("ask");
    expect(decideFsPolicy(fact({ toolClass: "write", mode: "auto", hasPrompt: false }))).toBe(
      "block",
    );
  });

  test("write + read-only defers to the name gate so a yes cannot punch through", () => {
    expect(decideFsPolicy(fact({ toolClass: "write", mode: "read-only", hasPrompt: true }))).toBe(
      "name-gate",
    );
    expect(decideFsPolicy(fact({ toolClass: "write", mode: "read-only", hasPrompt: false }))).toBe(
      "name-gate",
    );
  });

  test("standing deny blocks even after a skip-permissions seed", () => {
    expect(
      decideFsPolicy(fact({ standingDeny: true, consent: "allowed-this-run", hasPrompt: true })),
    ).toBe("block");
  });

  test("denied-this-run blocks without asking again", () => {
    expect(decideFsPolicy(fact({ consent: "denied-this-run", hasPrompt: true }))).toBe("block");
  });

  test("allowed-this-run falls through to the name gate", () => {
    expect(decideFsPolicy(fact({ consent: "allowed-this-run" }))).toBe("name-gate");
    expect(
      decideFsPolicy(
        fact({ consent: "allowed-this-run", toolClass: "write", mode: "approve-each" }),
      ),
    ).toBe("name-gate");
  });
});

describe("reduceConsent", () => {
  test("unasked + granted is allowed-this-run", () => {
    expect(reduceConsent("unasked", { type: "granted" })).toBe("allowed-this-run");
  });

  test("unasked + declined is denied-this-run", () => {
    expect(reduceConsent("unasked", { type: "declined" })).toBe("denied-this-run");
  });

  test("a second event against a terminal latch returns the same latch", () => {
    expect(reduceConsent("allowed-this-run", { type: "declined" })).toBe("allowed-this-run");
    expect(reduceConsent("denied-this-run", { type: "granted" })).toBe("denied-this-run");
  });
});
