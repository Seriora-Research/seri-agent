import { dirname } from "node:path";
import { foldsCase } from "../caseFold";
import { type PathDenial, pathMatchesDenial } from "./gate";
import { isInsideWorkingDir, resolveAgainstCwd } from "./workingDir";

export type DestructiveKind = "remove" | "move";

export type DestructiveIntent = {
  readonly kind: DestructiveKind;
  readonly targets: readonly string[];
  readonly quotingWidened: boolean;
};

const REMOVE_VERB = /\b(?:rmdir|Remove-Item|unlink|rm|del|erase|rd|ri)\b/i;

const MOVE_VERB = /\b(?:Move-Item|Rename-Item|rename|ren|mv|move)\b/i;

const ROBOCOPY = /\brobocopy\b/i;
const ROBOCOPY_MOVE = /(?:^|\s)\/MOVE\b/i;

type PathToken = { readonly raw: string; readonly quotingWidened: boolean };

function commandOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function posixify(path: string): string {
  return path.replaceAll("\\", "/");
}

function looksLikePath(token: string): boolean {
  if (token.length === 0 || /\s/.test(token)) return false;
  if (/^\/[A-Za-z]{1,8}$/.test(token)) return false;
  if (token.startsWith("-") && !token.includes("/") && !/^[A-Za-z]:/.test(token)) {
    return false;
  }
  return (
    token.includes("/") || token.includes("\\") || /^[A-Za-z]:/.test(token) || token.startsWith(".")
  );
}

function parentOf(path: string): string {
  const slash = posixify(path).replace(/\/+$/, "");
  return dirname(slash);
}

function tokenFromQuoted(raw: string): PathToken {
  if (raw.endsWith("\\")) return { raw: parentOf(raw), quotingWidened: true };
  return { raw, quotingWidened: false };
}

function collectQuoted(command: string): PathToken[] {
  const found: PathToken[] = [];
  const escaped = [...command.matchAll(/\\"([^"]*)"/g)];
  for (const match of escaped) {
    found.push(tokenFromQuoted(match[1] ?? ""));
  }
  if (escaped.length === 0) {
    for (const match of command.matchAll(/"([^"]*)"/g)) {
      found.push(tokenFromQuoted(match[1] ?? ""));
    }
  }
  for (const match of command.matchAll(/'([^']*)'/g)) {
    found.push({ raw: match[1] ?? "", quotingWidened: false });
  }
  return found;
}

function collectBare(command: string): PathToken[] {
  const hasEscaped = /\\"/.test(command);
  const stripped = hasEscaped
    ? command.replaceAll(/\\"[^"]*"/g, " ").replaceAll(/'[^']*'/g, " ")
    : command.replaceAll(/"[^"]*"/g, " ").replaceAll(/'[^']*'/g, " ");
  return stripped
    .split(/\s+/)
    .filter(looksLikePath)
    .map((raw) => ({ raw, quotingWidened: false }));
}

function kindOf(command: string): DestructiveKind | undefined {
  if (ROBOCOPY.test(command) && ROBOCOPY_MOVE.test(command)) return "move";
  if (REMOVE_VERB.test(command)) return "remove";
  if (MOVE_VERB.test(command)) return "move";
  return undefined;
}

export function destructiveIntentOf(
  toolName: string,
  input: unknown,
  cwd: string,
): DestructiveIntent | undefined {
  if (toolName !== "bash" && toolName !== "powershell") return undefined;
  const command = commandOf(input);
  if (command === undefined) return undefined;
  const kind = kindOf(command);
  if (kind === undefined) return undefined;
  const tokens = [...collectQuoted(command), ...collectBare(command)];
  const quotingWidened = tokens.some((token) => token.quotingWidened);
  const targets = [
    ...new Set(
      tokens
        .filter((token) => looksLikePath(token.raw) || token.quotingWidened)
        .map((token) => resolveAgainstCwd(cwd, posixify(token.raw))),
    ),
  ];
  return { kind, targets, quotingWidened };
}

function matchKey(path: string): string {
  return foldsCase() ? path.toLowerCase() : path;
}

export function treesOverlap(a: string, b: string): boolean {
  const left = posixify(a);
  const right = posixify(b);
  if (matchKey(left) === matchKey(right)) return true;
  return isInsideWorkingDir(left, right) || isInsideWorkingDir(right, left);
}

export function followUpBlocked(
  deniedTargets: readonly string[],
  intent: DestructiveIntent,
): boolean {
  if (deniedTargets.length === 0) return false;
  if (intent.targets.length === 0) return true;
  return intent.targets.some((target) =>
    deniedTargets.some((denied) => treesOverlap(target, denied)),
  );
}

export function writeFileDenialCovers(
  denials: readonly PathDenial[] | undefined,
  intent: DestructiveIntent | undefined,
  cwd: string | undefined,
): boolean {
  if (intent === undefined || denials === undefined || denials.length === 0) return false;
  return denials.some((denial) => {
    if (denial.tool !== "write_file") return false;
    if (intent.targets.length === 0) return true;
    return intent.targets.some((target) => pathMatchesDenial(denial.pattern, target, cwd));
  });
}
