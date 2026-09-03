import { describe, expect, test } from "bun:test";
import { composeBorderTitle } from "../../src/tui/util/borderTitle";

describe("composeBorderTitle", () => {
  test("left title plus Esc sits on one rule", () => {
    const title = composeBorderTitle("/config — settings", "Esc", 40);
    expect(title.startsWith("/config — settings ")).toBe(true);
    expect(title.endsWith(" Esc")).toBe(true);
    expect(title).toContain("─");
  });

  test("an empty right side is just the title", () => {
    expect(composeBorderTitle("approve", "", 80)).toBe("approve");
  });
});
