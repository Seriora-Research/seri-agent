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
  startsATurn,
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
  "/hooks",
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
  "/hooks",
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

/*
 * The published command reference, held to the same completeness bar as the README beside it.
 * Read from here rather than asserted inside apps/docs: this is the file a command is added to,
 * so this is where the failure has to land, and pulling this catalog into the docs package's own
 * tsconfig made it typecheck apps/cli's whole module graph against a different target.
 */
const DOCS_COMMANDS = readFileSync(
  join(import.meta.dir, "../../../docs/reference/commands.mdx"),
  "utf8",
);

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

  test("the docs command reference names every catalog command as a /name token", () => {
    const missing = COMMAND_META.map((meta) => meta.name).filter(
      (name) => !mentionsName(DOCS_COMMANDS, name),
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

// The one question cli.ts's message queue asks before it defers a submission instead of running it.
// Every branch is exercised here rather than through the TUI, which is the reason it is a pure
// function taking its registries as an argument at all.
describe("startsATurn", () => {
  const registries = {
    agents: new Map<string, unknown>([["reviewer", {}]]),
    skills: new Map<string, unknown>([["summarize", {}]]),
  };

  test("a plain task starts a turn", () => {
    expect(startsATurn("fix", "fix the wrap", registries)).toBe(true);
  });

  test("a skill starts a turn, because its body is submitted as an ordinary user turn", () => {
    expect(startsATurn("/summarize", "/summarize the diff", registries)).toBe(true);
    expect(startsATurn("/summarize", "/summarize", registries)).toBe(true);
  });

  test("an agent dispatch with a goal starts a turn", () => {
    expect(startsATurn("/reviewer", "/reviewer grade the diff", registries)).toBe(true);
  });

  // Deferring this one would put the usage error minutes away from the keypress that caused it,
  // with nothing on screen to connect them. Falling through runs the error cli.ts already prints.
  test("an agent dispatch with no goal does not, so its usage error stays immediate", () => {
    expect(startsATurn("/reviewer", "/reviewer", registries)).toBe(false);
    expect(startsATurn("/reviewer", "/reviewer   ", registries)).toBe(false);
  });

  // Both halves of the catalog: a TUI-claimed name opens a panel or quits, and a session command
  // has its own mid-turn gate. Neither may be deferred, or /exit would stop working mid-turn.
  test("no catalog command starts a turn", () => {
    for (const meta of COMMAND_META) {
      expect(startsATurn(meta.name, meta.name, registries)).toBe(false);
    }
  });

  test("an unrecognised slash name does not, so its error stays immediate too", () => {
    expect(startsATurn("/nope", "/nope whatever", registries)).toBe(false);
  });

  test("a name defined as both an agent and a skill is judged as the agent", () => {
    const both = {
      agents: new Map<string, unknown>([["shared", {}]]),
      skills: new Map<string, unknown>([["shared", {}]]),
    };
    expect(startsATurn("/shared", "/shared", both)).toBe(false);
    expect(startsATurn("/shared", "/shared do it", both)).toBe(true);
  });
});
