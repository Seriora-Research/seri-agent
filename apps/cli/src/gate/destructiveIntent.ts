import { homedir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
import { foldsCase } from "../caseFold";
import { type PathDenial, pathMatchesDenial } from "./gate";
import {
  type CallLocation,
  canonicalizeAgainstCwd,
  canonicalizeEntryAgainstCwd,
  canonicalizeEntryResolvedAgainstCwd,
  isEntryInsideWorkingDir,
  isInsideWorkingDir,
} from "./workingDir";

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

const RECURSIVE_FLAG = /(?:^|\s)(?:-[rR]f\b|-[fF][rR]\b|-[rR]\b|--recursive\b|\/[sS]\b|-Recurse\b)/;

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

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function isUrl(token: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token);
}

function isGitScp(token: string): boolean {
  return /^[^/\\]+@[^/\\]+:/.test(token);
}

function looksLikeFsPath(token: string): boolean {
  if (token.length === 0 || /\s/.test(token)) return false;
  if (isEnvAssignment(token) || isUrl(token) || isGitScp(token)) return false;
  if (/^\/[A-Za-z]{1,8}$/.test(token)) return false;
  if (token.startsWith("-") && !token.includes("/") && !/^[A-Za-z]:/.test(token)) {
    return false;
  }
  if (isVerbToken(token) || SHELL_WORDS.test(token)) return false;
  if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) return true;
  return (
    token.includes("/") || token.includes("\\") || /^[A-Za-z]:/.test(token) || token.startsWith(".")
  );
}

function looksLikePath(token: string): boolean {
  if (looksLikeFsPath(token)) return true;
  if (token.length === 0 || /\s/.test(token)) return false;
  if (isEnvAssignment(token) || isUrl(token)) return false;
  if (isVerbToken(token) || SHELL_WORDS.test(token)) return false;
  if (token.startsWith("-")) return false;
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

function splitSimpleCommands(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      if (quote === '"' && ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segments.push(command.slice(start, i));
      start = i + 1;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      segments.push(command.slice(start, i));
      start = i + 2;
      i++;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      segments.push(command.slice(start, i));
      start = i + 2;
      i++;
      continue;
    }
    if (ch === "|") {
      segments.push(command.slice(start, i));
      start = i + 1;
      continue;
    }
    if (ch === "&") {
      const prev = i > 0 ? command[i - 1] : "";
      if (prev === ">" || prev === "<") continue;
      segments.push(command.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(command.slice(start));
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

function tokensInOrder(segment: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < segment.length) {
    while (i < segment.length && isBlank(segment[i])) i++;
    if (i >= segment.length) break;
    const ch = segment[i];
    if (ch === "'" || ch === '"') {
      const closer = ch;
      i++;
      let raw = "";
      while (i < segment.length) {
        const next = segment[i];
        if (closer === '"' && next === "\\") {
          raw += segment[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (next === closer) {
          i++;
          break;
        }
        raw += next;
        i++;
      }
      tokens.push(raw);
      continue;
    }
    let end = i;
    while (end < segment.length && !isBlank(segment[end])) end++;
    tokens.push(segment.slice(i, end));
    i = end;
  }
  return tokens;
}

type HeredocOp = {
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
};

function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

function parseHeredocDelimiter(
  command: string,
  start: number,
): { delimiter: string; quoted: boolean; next: number } | undefined {
  if (start >= command.length || command[start] === "\n") return undefined;
  const opener = command[start];
  if (opener === "'" || opener === '"') {
    const close = command.indexOf(opener, start + 1);
    if (close === -1) return undefined;
    return { delimiter: command.slice(start + 1, close), quoted: true, next: close + 1 };
  }
  if (opener === "\\" && start + 1 < command.length && command[start + 1] !== "\n") {
    return { delimiter: command[start + 1] ?? "", quoted: true, next: start + 2 };
  }
  let end = start;
  while (end < command.length) {
    const ch = command[end];
    if (ch === undefined || isBlank(ch) || /[;&|<>(){}\n]/.test(ch)) break;
    end++;
  }
  if (end === start) return undefined;
  return { delimiter: command.slice(start, end), quoted: false, next: end };
}

function matchingParen(command: string, open: number, end: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = open + 1; i < end; i++) {
    const ch = command[i];
    if (quote !== null) {
      if (quote === '"' && ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findTerminator(
  command: string,
  from: number,
  delimiter: string,
  stripTabs: boolean,
): { bodyEnd: number; after: number } {
  let lineStart = from;
  for (let i = from; i <= command.length; i++) {
    if (i !== command.length && command[i] !== "\n") continue;
    const raw = command.slice(lineStart, i);
    const line = stripTabs ? raw.replace(/^\t+/, "") : raw;
    if (line === delimiter) {
      return { bodyEnd: lineStart, after: i === command.length ? i : i + 1 };
    }
    lineStart = i + 1;
  }
  return { bodyEnd: command.length, after: command.length };
}

function consumeHeredocs(
  command: string,
  out: string[],
  pending: HeredocOp[],
  bodyStart: number,
): number {
  let start = bodyStart;
  for (const op of pending) {
    const found = findTerminator(command, start, op.delimiter, op.stripTabs);
    maskRange(out, command, start, found.bodyEnd, !op.quoted);
    start = found.after;
  }
  pending.length = 0;
  return start;
}

function maskRange(
  out: string[],
  command: string,
  start: number,
  end: number,
  preserveSubstitutions: boolean,
): void {
  if (!preserveSubstitutions) {
    for (let i = start; i < end; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
    return;
  }
  let i = start;
  while (i < end) {
    if (command.startsWith("$(", i) && !command.startsWith("$((", i)) {
      const close = matchingParen(command, i + 1, end);
      i = close === -1 ? end : close + 1;
      continue;
    }
    if (command[i] === "`") {
      const close = command.indexOf("`", i + 1);
      i = close === -1 || close >= end ? end : close + 1;
      continue;
    }
    if (out[i] !== "\n") out[i] = " ";
    i++;
  }
}

function maskHeredocBodies(command: string): string {
  const out = command.split("");
  const pending: HeredocOp[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let arith = 0;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote !== null) {
      if (quote !== "'" && ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (arith > 0) {
      if (command.startsWith("$((", i)) {
        arith++;
        i += 3;
        continue;
      }
      if (command.startsWith("))", i)) {
        arith--;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (command.startsWith("$((", i)) {
      arith++;
      i += 3;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        i += 3;
        continue;
      }
      let pos = i + 2;
      let stripTabs = false;
      if (command[pos] === "-") {
        stripTabs = true;
        pos++;
      }
      while (isBlank(command[pos])) pos++;
      const parsed = parseHeredocDelimiter(command, pos);
      if (parsed !== undefined) {
        pending.push({ delimiter: parsed.delimiter, quoted: parsed.quoted, stripTabs });
        i = parsed.next;
        continue;
      }
      i += 2;
      continue;
    }
    if (pending.length > 0 && (ch === "\n" || i === command.length - 1)) {
      const bodyStart = ch === "\n" ? i + 1 : command.length;
      i = consumeHeredocs(command, out, pending, bodyStart);
      continue;
    }
    i++;
  }
  if (pending.length > 0) consumeHeredocs(command, out, pending, command.length);
  return out.join("");
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

function resolveTarget(cwd: string, raw: string, toolName: string): string {
  const expanded = expandUser(raw);
  if (isVolumeRootRaw(expanded)) {
    const posix = posixify(expanded).replace(/\/+$/, "");
    return posix === "" ? "/" : posix;
  }
  const path = process.platform === "win32" ? expanded : posixify(expanded);
  if (toolName === "powershell") return canonicalizeEntryResolvedAgainstCwd(cwd, path);
  return canonicalizeEntryAgainstCwd(cwd, path);
}

export function destructiveIntentOf(
  toolName: string,
  input: unknown,
  cwd: string,
): DestructiveIntent | undefined {
  if (toolName !== "bash" && toolName !== "powershell") return undefined;
  const command = commandOf(input);
  if (command === undefined) return undefined;
  const scanned = maskHeredocBodies(command);
  const kind = kindOf(scanned);
  if (kind === undefined) return undefined;
  const tokens = [...collectQuoted(scanned), ...collectBare(scanned)];
  const quotingWidened = tokens.some((token) => token.quotingWidened);
  const targets = [
    ...new Set(
      tokens
        .filter((token) => looksLikePath(token.raw) || token.quotingWidened)
        .map((token) => resolveTarget(cwd, token.raw, toolName)),
    ),
  ];
  return { kind, targets, quotingWidened, recursive: isRecursive(scanned) };
}

function matchKey(path: string): string {
  return foldsCase() ? path.toLowerCase() : path;
}

function samePath(a: string, b: string): boolean {
  return matchKey(canonicalizeAgainstCwd(".", a)) === matchKey(canonicalizeAgainstCwd(".", b));
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
  const workspace = cwd !== undefined && cwd !== "" ? canonicalizeAgainstCwd(cwd, ".") : undefined;
  for (const target of intent.targets) {
    if (isVolumeRootTarget(target)) return { reason: "volume-root", target };
    if (workspace !== undefined && samePath(target, workspace)) {
      return { reason: "workspace-root", target };
    }
    if (workspace !== undefined && !isEntryInsideWorkingDir(workspace, target)) {
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

export function namedShellPaths(toolName: string, input: unknown, cwd: string): readonly string[] {
  if (toolName !== "bash" && toolName !== "powershell") return [];
  const command = commandOf(input);
  if (command === undefined) return [];
  const scanned = maskHeredocBodies(command);
  const named: string[] = [];
  for (const segment of splitSimpleCommands(scanned)) {
    for (const token of tokensInOrder(segment).slice(1)) {
      if (!looksLikeFsPath(token)) continue;
      named.push(resolveTarget(cwd, token, toolName));
    }
  }
  return [...new Set(named)];
}

export function namedPathDenialCovers(
  patterns: readonly string[] | undefined,
  paths: readonly string[],
  cwd: string | undefined,
): boolean {
  if (patterns === undefined || patterns.length === 0 || paths.length === 0) return false;
  return paths.some((path) => patterns.some((pattern) => pathMatchesDenial(pattern, path, cwd)));
}

export function locationForShellCall(cwd: string, paths: readonly string[]): CallLocation {
  if (paths.length === 0) return "nopath";
  if (cwd === "") return "outside";
  return paths.some((path) => !isInsideWorkingDir(cwd, path)) ? "outside" : "inside";
}
