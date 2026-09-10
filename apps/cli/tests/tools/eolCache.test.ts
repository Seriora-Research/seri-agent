import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { advanceEolEpoch, eolEpoch, getCachedEol, setCachedEol } from "../../src/tools/eolCache";

function key(label: string): string {
  return `eol-cache-test:${label}:${randomUUID()}`;
}

describe("eolCache", () => {
  test("setCachedEol ignores an observation captured before a later write", () => {
    const path = key("write");
    const observedAt = eolEpoch();
    advanceEolEpoch();
    setCachedEol(path, "LF");
    setCachedEol(path, "CRLF", observedAt);
    expect(getCachedEol(path)).toBe("LF");
  });

  test("setCachedEol ignores a stale observation when the path was never cached", () => {
    const path = key("stale");
    const observedAt = eolEpoch();
    advanceEolEpoch();
    setCachedEol(path, "CRLF", observedAt);
    expect(getCachedEol(path)).toBeUndefined();
  });

  test("setCachedEol still records an observation from the current epoch", () => {
    const path = key("current");
    const observedAt = eolEpoch();
    setCachedEol(path, "CRLF", observedAt);
    expect(getCachedEol(path)).toBe("CRLF");
  });
});
