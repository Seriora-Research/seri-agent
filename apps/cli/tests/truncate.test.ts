import { describe, expect, test } from "bun:test";
import { truncate } from "../src/truncate";

describe("truncate", () => {
  test("leaves text at or under the cap untouched", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  test("cuts text over the cap and marks it with an ellipsis", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
  });
});
