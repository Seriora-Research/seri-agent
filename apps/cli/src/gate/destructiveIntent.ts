import { homedir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
import { foldsCase } from "../caseFold";
import { type PathDenial, pathMatchesDenial } from "./gate";
import { isInsideWorkingDir, resolveAgainstCwd } from "./workingDir";

export type DestructiveKind = "remove" | "move";

export type DestructiveIntent = {
  readonly kind: DestructiveKind;
  readonly targets: readonly string[];
  readonly quotingWidened: boolean;
  readonly recursive: boolean;
};

export type CatastrophicReason =
  | "unresolved-recursive"
  | "volume-root"
  | "workspace-root"
  | "workspace-escape";

export type CatastrophicHit = {
  readonly reason: CatastrophicReason;
  readonly target?: string;
};

const REMOVE_VERB = /\b(?:rmdir|Remove-Item|unlink|rm|del|erase|rd|ri)\b/i;

const MOVE_VERB = /\b(?:Move-Item|Rename-Item|rename|ren|mv|move)\b/i;

const ROBOCOPY = /\brobocopy\b/i;
const ROBOCOPY_MOVE = /(?:^|\s)\/MOVE\b/i;

const RECURSIVE_FLAG =
  /(?:^|\s)(?:-[rR]f\b|-[fF][rR]\b|-[rR]\b|--recursive\b|\/[sS]\b|-Recurse\b)/;

const SHELL_WORDS = /^(?:cmd|bash|sh|zsh|fish|pwsh|powershell|sudo|env)$/i;

type PathToken = { readonly raw: string; readonly quotingWidened: boolean };

function commandOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function posixify(path: string): string {
  return path.replaceAll("\\", "/");
}

function isVerbToken(token: string): boolean {
  return REMOVE_VERB.test(token) || MOVE_VERB.test(token) || ROBOCOPY.test(token);
}

function looksLikePath(token: string): boolean {
  if (token.length === 0 || /\s/.test(token)) return false;
  if (/^\/[A-Za-z]{1,8}$/.test(token)) return false;
  if (token.startsWith("-") && !token.includes("/") && !/^[A-Za-z]:/.test(token)) {
    return false;
  }
  if (isVerbToken(token) || SHELL_WORDS.test(token)) return false;
  if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) return true;
  if (
    token.includes("/") ||
    token.includes("\\") ||
    /^[A-Za-z]:/.test(token) ||
    token.startsWith(".")
  ) {
    return true;
  }
  return /^[\w][\w.+-]*$/.test(token);
}

function parentOf(path: string): string {
  const slash = posixify(path).replace(/\/+$/, "");
  return dirname(slash);
}

function tokenFromQuoted(raw: string): PathToken {
  if (isVolumeRootRaw(raw)) {
    const posix = posixify(raw).replace(/\/+$/, "");
    return { raw: posix === "" ? "/" : posix, quotingWidened: false };
  }
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

function isRecursive(command: string): boolean {
  return RECURSIVE_FLAG.test(command);
}

function expandUser(raw: string): string {
  if (raw === "~" || raw === "~/" || raw === "~\\") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

function isVolumeRootRaw(raw: string): boolean {
  const posix = posixify(raw);
  if (/^\/+$/.test(posix)) return true;
  return /^[A-Za-z]:$/.test(posix.replace(/\/+$/, ""));
}

function resolveTarget(cwd: string, raw: string): string {
  const expanded = expandUser(raw);
  if (isVolumeRootRaw(expanded)) {
    const posix = posixify(expanded).replace(/\/+$/, "");
    return posix === "" ? "/" : posix;
  }
  return resolveAgainstCwd(cwd, posixify(expanded));
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
        .map((token) => resolveTarget(cwd, token.raw)),
    ),
  ];
  return { kind, targets, quotingWidened, recursive: isRecursive(command) };
}

function matchKey(path: string): string {
  return foldsCase() ? path.toLowerCase() : path;
}

function samePath(a: string, b: string): boolean {
  return matchKey(resolve(a)) === matchKey(resolve(b));
}

function isVolumeRootTarget(path: string): boolean {
  if (isVolumeRootRaw(path)) return true;
  const resolved = resolve(path);
  const root = parse(resolved).root;
  if (root === "") return false;
  return matchKey(resolved) === matchKey(root) || matchKey(resolved + sep) === matchKey(root);
}

export function catastrophicOf(
  intent: DestructiveIntent | undefined,
  cwd: string | undefined,
): CatastrophicHit | undefined {
  if (intent === undefined) return undefined;
  if (intent.recursive && intent.targets.length === 0) {
    return { reason: "unresolved-recursive" };
  }
  const workspace = cwd !== undefined && cwd !== "" ? resolve(cwd) : undefined;
  for (const target of intent.targets) {
    if (isVolumeRootTarget(target)) return { reason: "volume-root", target };
    if (workspace !== undefined && samePath(target, workspace)) {
      return { reason: "workspace-root", target };
    }
    if (workspace !== undefined && !isInsideWorkingDir(workspace, target)) {
      return { reason: "workspace-escape", target };
    }
  }
  return undefined;
}

export function catastrophicDenyReason(subject: string, hit: CatastrophicHit): string {
  const detail =
    hit.reason === "unresolved-recursive"
      ? "recursive remove with no resolved target"
      : hit.reason === "volume-root"
        ? `volume root (${hit.target})`
        : hit.reason === "workspace-root"
          ? "session working directory"
          : `path outside the working directory (${hit.target})`;
  return (
    `Tool "${subject}" was blocked as a catastrophic filesystem operation: ${detail}. ` +
    `Do not retry this call or a variant of it. The block is a harness rail; ` +
    `/mode and --dangerously-skip-permissions do not lift it.`
  );
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
