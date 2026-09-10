import { describe, expect, test } from "bun:test";
import {
  advanceEolEpoch,
  clearEolCache,
  eolEpoch,
  getCachedEol,
  setCachedEol,
} from "../../src/tools/eolCache";

describe("eolCache", () => {
  test("setCachedEol ignores an observation captured before a cache clear", () => {
    const path = "/tmp/seri-eol-clear.txt";
    const observedAt = eolEpoch();
    clearEolCache();
    setCachedEol(path, "CRLF", observedAt);
    expect(getCachedEol(path)).toBeUndefined();
  });

  test("setCachedEol ignores an observation captured before a later write", () => {
    const path = "/tmp/seri-eol-write.txt";
    const observedAt = eolEpoch();
    advanceEolEpoch();
    setCachedEol(path, "LF");
    setCachedEol(path, "CRLF", observedAt);
    expect(getCachedEol(path)).toBe("LF");
  });

  test("setCachedEol still records an observation from the current epoch", () => {
    const path = "/tmp/seri-eol-current.txt";
    const observedAt = eolEpoch();
    setCachedEol(path, "CRLF", observedAt);
    expect(getCachedEol(path)).toBe("CRLF");
  });
});
