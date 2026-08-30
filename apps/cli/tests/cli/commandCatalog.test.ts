import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SLASH_COMMANDS } from "../../src/cli";
import {
  assertTuiHandlers,
  COMMAND_META,
  commandByName,
  isShiftTabModeCycle,
  isTuiClaimed,
  sessionMeta,
  tuiClaimedNames,
} from "../../src/cli/commandCatalog";
import { USAGE } from "../../src/cli/output";

const EXPECTED_NAMES = [
  "/mode",
  "/effort",
  "/undo",
  "/restore",
  "/rewind",
  "/clear",
  "/compact",
  "/memory",
  "/trajectory",
  "/usage",
  "/exit",
  "/model",
  "/setup",
  "/login",
  "/signup",
  "/logout",
  "/config",
  "/permissions",
  "/skills",
  "/mcp",
  "/max-turns",
  "/profile",
] as const;

const EXPECTED_TUI_CLAIMED = [
  "/effort",
  // Session-surface, TUI-claimed: the bare form opens the review panel here, while
  // `seri "/memory approve all"` still runs on the non-TTY path that has no panel to open.
  "/memory",
  "/exit",
  "/model",
  "/setup",
  "/login",
  "/signup",
  "/logout",
  "/config",
  "/permissions",
  "/skills",
  "/mcp",
  "/max-turns",
  "/profile",
] as const;

const EXPECTED_SESSION = [
  "/mode",
  "/effort",
  "/undo",
  "/restore",
  "/rewind",
  "/clear",
  "/compact",
  "/memory",
  "/trajectory",
  "/usage",
] as const;

const README = readFileSync(join(import.meta.dir, "../../../../README.md"), "utf8");

function mentionsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?![A-Za-z0-9_-])`).test(text);
}

describe("command catalog completeness", () => {
  test("COMMAND_META lists exactly the closed set of names", () => {
    expect(COMMAND_META.map((meta) => meta.name)).toEqual([...EXPECTED_NAMES]);
  });

  test("README names every catalog command as a /name token", () => {
    const missing = COMMAND_META.map((meta) => meta.name).filter(
      (name) => !mentionsName(README, name),
    );
    expect(missing).toEqual([]);
  });

  test("USAGE is launch-only and does not list catalog slash names", () => {
    expect(USAGE).toContain("seri serve");
    expect(USAGE).toContain("seri exec");
    expect(USAGE).not.toContain("seri config");
    expect(USAGE).not.toContain("seri login");
    expect(USAGE).not.toContain("seri usage");
    expect(USAGE).not.toContain("seri permissions");
    const slashInUsage = COMMAND_META.map((meta) => meta.name).filter((name) =>
      mentionsName(USAGE, name),
    );
    expect(slashInUsage).toEqual([]);
  });

  test("SLASH_COMMANDS is the session slice and does not include /exit", () => {
    expect([...SLASH_COMMANDS.keys()]).toEqual([...EXPECTED_SESSION]);
    expect(SLASH_COMMANDS.has("/exit")).toBe(false);
    expect(sessionMeta().map((meta) => meta.name)).toEqual([...EXPECTED_SESSION]);
  });

  test("/effort is tuiClaimsFirst so the TUI path never falls through to effortCommand", () => {
    const effort = commandByName("/effort");
    expect(effort?.surface).toBe("session");
    if (effort === undefined || effort.surface !== "session") {
      throw new Error("expected /effort in the catalog");
    }
    expect(effort.tuiClaimsFirst).toBe(true);
    expect(isTuiClaimed(effort)).toBe(true);
  });

  test("/mode shortcut is shift+tab", () => {
    expect(commandByName("/mode")?.shortcut?.chord).toBe("shift+tab");
  });

  test("tuiClaimedNames is the TUI surface plus /effort and /memory", () => {
    expect(tuiClaimedNames()).toEqual([...EXPECTED_TUI_CLAIMED]);
  });

  test("assertTuiHandlers throws when /model is missing from the Record", () => {
    const handlers: Record<string, unknown> = Object.fromEntries(
      EXPECTED_TUI_CLAIMED.filter((name) => name !== "/model").map((name) => [name, () => {}]),
    );
    expect(() => assertTuiHandlers(handlers)).toThrow("tuiHandlers missing /model");
  });

  test("isShiftTabModeCycle matches tab+shift only when /mode's chord is shift+tab", () => {
    expect(commandByName("/mode")?.shortcut?.chord).toBe("shift+tab");
    expect(isShiftTabModeCycle({ name: "tab", shift: true })).toBe(true);
    expect(isShiftTabModeCycle({ name: "tab", shift: false })).toBe(false);
    expect(isShiftTabModeCycle({ name: "enter", shift: true })).toBe(false);
  });
});
