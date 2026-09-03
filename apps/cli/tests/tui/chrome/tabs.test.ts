import { describe, expect, test } from "bun:test";
import { CHROME_TABS, isChromeTabId, nextChromeTab } from "../../../src/tui/chrome/tabs";

describe("chrome tabs", () => {
  test("this ship registers Usage only", () => {
    expect(CHROME_TABS).toEqual([{ id: "usage", label: "Usage" }]);
    expect(isChromeTabId("usage")).toBe(true);
    expect(isChromeTabId("setup")).toBe(false);
  });

  test("nextChromeTab wraps the closed list", () => {
    expect(nextChromeTab("usage", 1)).toBe("usage");
    expect(nextChromeTab("usage", -1)).toBe("usage");
  });
});
