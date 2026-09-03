export const CHROME_TAB_IDS = ["usage"] as const;

export type ChromeTabId = (typeof CHROME_TAB_IDS)[number];

export type ChromeTab = {
  id: ChromeTabId;
  label: string;
};

export const CHROME_TABS: readonly ChromeTab[] = [{ id: "usage", label: "Usage" }];

export function isChromeTabId(value: string): value is ChromeTabId {
  return (CHROME_TAB_IDS as readonly string[]).includes(value);
}

export function nextChromeTab(id: ChromeTabId, delta: 1 | -1): ChromeTabId {
  const index = CHROME_TABS.findIndex((tab) => tab.id === id);
  const count = CHROME_TABS.length;
  return CHROME_TABS[(index + delta + count) % count]!.id;
}
