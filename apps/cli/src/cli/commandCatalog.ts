import { memoryCommandAccepts } from "../memory/commands";

export type CommandShortcut = { chord: "shift+tab" };

export type CommandMeta = {
  name: `/${string}`;
  aliases?: readonly `/${string}`[];
  description: string;
  argsUsage: string;
  accepts: (args: string[]) => boolean;
  shortcut?: CommandShortcut;
} & (
  | {
      surface: "session";
      mutatesRunState?: true;
      scopeTargetToCwd?: true;
      needsSession?: true | false;
      tuiClaimsFirst?: true;
      readsDetailFlag?: true;
    }
  | { surface: "tui" }
);

function isStepCount(args: string[]): boolean {
  return args.length === 0 || (args.length === 1 && /^[1-9]\d*$/.test(args[0] ?? ""));
}

export const COMMAND_META: readonly CommandMeta[] = [
  {
    name: "/mode",
    surface: "session",
    description: "cycle the permission mode",
    argsUsage: "",
    accepts: (args) => args.length === 0,
    shortcut: { chord: "shift+tab" },
  },
  {
    name: "/effort",
    surface: "session",
    description: "show, set, or clear this session's reasoning-effort override",
    argsUsage: "[level|auto]",
    accepts: (args) => args.length <= 1,
    mutatesRunState: true,
    // TUI claims every form before effortCommand so that path never awaits a catalog/plan fetch
    // while a turn can clobber session-updated.
    tuiClaimsFirst: true,
  },
  {
    name: "/undo",
    surface: "session",
    description: "step back through file checkpoints",
    argsUsage: "[n]",
    accepts: isStepCount,
    mutatesRunState: true,
  },
  {
    name: "/restore",
    surface: "session",
    description: "restore a checkpoint by sha",
    argsUsage: "<sha>",
    accepts: (args) => args.length === 1 && /^[0-9a-f]{4,40}$/.test(args[0] ?? ""),
    mutatesRunState: true,
  },
  {
    name: "/rewind",
    surface: "session",
    description: "rewind the conversation",
    argsUsage: "[n]",
    accepts: isStepCount,
    mutatesRunState: true,
  },
  {
    name: "/clear",
    surface: "session",
    description: "start a new session",
    argsUsage: "",
    accepts: (args) => args.length === 0,
    mutatesRunState: true,
    scopeTargetToCwd: true,
  },
  {
    name: "/compact",
    surface: "session",
    description: "summarize older messages so the conversation fits the context window",
    argsUsage: "",
    accepts: (args) => args.length === 0,
    mutatesRunState: true,
  },
  {
    name: "/memory",
    surface: "session",
    description: "review and act on staged memory writes",
    argsUsage: "pending|…",
    accepts: memoryCommandAccepts,
    mutatesRunState: true,
    needsSession: false,
  },
  {
    name: "/trajectory",
    surface: "session",
    description: "show or set local trajectory recording for this profile",
    argsUsage: "[on|off]",
    accepts: (args) =>
      args.length === 0 || (args.length === 1 && (args[0] === "on" || args[0] === "off")),
    needsSession: false,
  },
  {
    name: "/usage",
    surface: "session",
    description: "hosted-gateway spend vs allowance",
    argsUsage: "[--detail]",
    accepts: (args) => args.length === 0 || (args.length === 1 && args[0] === "--detail"),
    needsSession: false,
    readsDetailFlag: true,
  },
  {
    name: "/exit",
    surface: "tui",
    description: "end the session",
    argsUsage: "",
    accepts: (args) => args.length === 0,
  },
  {
    name: "/model",
    surface: "tui",
    description: "open the model picker",
    argsUsage: "",
    accepts: (args) => args.length === 0,
  },
  {
    name: "/setup",
    surface: "tui",
    description: "add, replace, or remove a provider API key",
    argsUsage: "",
    accepts: (args) => args.length === 0,
  },
  {
    name: "/login",
    surface: "tui",
    description: "sign in to a hosted seri account",
    argsUsage: "",
    accepts: (args) => args.length === 0,
  },
  {
    name: "/signup",
    surface: "tui",
    description: "create a hosted seri account",
    argsUsage: "",
    accepts: (args) => args.length === 0,
  },
  {
    name: "/logout",
    surface: "tui",
    description: "leave a hosted seri account",
    argsUsage: "",
    accepts: (args) => args.length === 0,
  },
  {
    name: "/config",
    surface: "tui",
    description: "view or edit non-provider settings",
    argsUsage: "",
    accepts: (args) => args.length === 0,
  },
  {
    name: "/permissions",
    surface: "tui",
    description: "view or revoke permanently approved tools",
    argsUsage: "",
    accepts: (args) => args.length === 0,
  },
  {
    name: "/max-turns",
    surface: "tui",
    description: "override the per-task turn budget for the rest of the session",
    argsUsage: "<n>",
    // Always claims the name; decideMaxTurns still throws on a bad argument.
    accepts: () => true,
  },
  {
    name: "/profile",
    surface: "tui",
    description: "create a new profile directory",
    argsUsage: "new <name>",
    // Always claims the name; decideProfileCreate still throws on a bad argument.
    accepts: () => true,
  },
];

const BY_NAME = new Map<string, CommandMeta>(COMMAND_META.map((meta) => [meta.name, meta]));

if (BY_NAME.size !== COMMAND_META.length) {
  throw new Error("duplicate command catalog name");
}

export function commandByName(name: string): CommandMeta | undefined {
  return BY_NAME.get(name);
}

export function sessionMeta(): Extract<CommandMeta, { surface: "session" }>[] {
  return COMMAND_META.filter(
    (meta): meta is Extract<CommandMeta, { surface: "session" }> => meta.surface === "session",
  );
}

export function isTuiClaimed(meta: CommandMeta): boolean {
  switch (meta.surface) {
    case "tui":
      return true;
    case "session":
      return meta.tuiClaimsFirst === true;
    default: {
      const _exhaustive: never = meta;
      return _exhaustive;
    }
  }
}

export function tuiClaimedNames(): string[] {
  return COMMAND_META.filter(isTuiClaimed).map((meta) => meta.name);
}

export function assertTuiHandlers(handlers: Record<string, unknown>): void {
  for (const name of tuiClaimedNames()) {
    if (!(name in handlers)) {
      throw new Error(`tuiHandlers missing ${name}`);
    }
  }
}

export function isShiftTabModeCycle(key: { name: string; shift: boolean }): boolean {
  if (commandByName("/mode")?.shortcut?.chord !== "shift+tab") return false;
  return key.name === "tab" && key.shift;
}
