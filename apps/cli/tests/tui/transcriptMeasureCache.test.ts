import { describe, expect, test } from "bun:test";
import { createTranscriptMeasureCache } from "../../src/tui/util/transcriptMeasureCache";

describe("createTranscriptMeasureCache", () => {
  test("follows surviving entries across a front-drop at constant length", () => {
    const cache = createTranscriptMeasureCache(() => {});
    const a = { role: "system" as const, text: "a" };
    const b = { role: "system" as const, text: "b" };
    const c = { role: "system" as const, text: "c" };
    cache.handlerFor(a).call({ height: 2 });
    cache.handlerFor(b).call({ height: 5 });
    cache.handlerFor(c).call({ height: 3 });
    expect(cache.sync([a, b, c])).toEqual([2, 5, 3]);
    expect(cache.sync([b, c])).toEqual([5, 3]);
    expect(cache.size()).toBe(2);
    expect(cache.sync([])).toEqual([]);
    expect(cache.size()).toBe(0);
  });

  test("reset drops every measured height", () => {
    const cache = createTranscriptMeasureCache(() => {});
    const a = { role: "system" as const, text: "a" };
    cache.handlerFor(a).call({ height: 2 });
    expect(cache.size()).toBe(1);
    cache.reset();
    expect(cache.size()).toBe(0);
    expect(cache.sync([a])).toEqual([undefined]);
  });
});
