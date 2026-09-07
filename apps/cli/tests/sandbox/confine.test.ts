import { describe, expect, test } from "bun:test";
import { probeConfinement } from "../../src/sandbox/confine";

describe("probeConfinement", () => {
  test("windows is never an OS sandbox upgrade", () => {
    expect(probeConfinement("win32", () => true)).toBe(false);
  });

  test("linux follows whether bwrap is actually on PATH", () => {
    expect(probeConfinement("linux", () => false)).toBe(false);
    expect(probeConfinement("linux", () => true)).toBe(true);
  });

  test("darwin follows whether sandbox-exec is actually on PATH", () => {
    expect(probeConfinement("darwin", () => false)).toBe(false);
    expect(probeConfinement("darwin", () => true)).toBe(true);
  });
});
