import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteFile, ensureOwnerOnlyDir } from "../atomicWriteFile";
import { getMemoriesDir } from "../config/paths";
import { projectKey } from "../permissions/store";
import { mergeTally, redactText, type SecretTally } from "../session/redact";
import { truncate } from "../truncate";

export type MemoryScope = "user" | "memory-global" | "memory-project";

export const MEMORY_CAPS: Record<MemoryScope, number> = {
  user: 1_375,
  "memory-global": 2_200,
  "memory-project": 2_200,
};

export type MemoryContext = { configDir: string; worktree: string };

export function projectDirToken(worktree: string): string {
  return createHash("sha256").update(projectKey(worktree)).digest("hex").slice(0, 16);
}

export function memoryFilePath(scope: MemoryScope, ctx: MemoryContext): string {
  const dir = getMemoriesDir(ctx.configDir);
  if (scope === "user") return join(dir, "USER.md");
  if (scope === "memory-global") return join(dir, "MEMORY.md");
  return join(dir, projectDirToken(ctx.worktree), "MEMORY.md");
}

export type MemoryEntry = { date: string; text: string; line: string };
export type MemoryFile = {
  scope: MemoryScope;
  path: string;
  text: string;
  chars: number;
  cap: number;
  entries: MemoryEntry[];

  label: string;
};
export type LoadedMemory = { user: MemoryFile; global: MemoryFile; project: MemoryFile };

const ENTRY_RE = /^- \[(\d{4}-\d{2}-\d{2})\] (.+)$/;

function parseEntries(text: string): MemoryEntry[] {
  if (text.length === 0) return [];
  return text.split("\n").map((line) => {
    const match = ENTRY_RE.exec(line);
    return match ? { date: match[1], text: match[2], line } : { date: "", text: line, line };
  });
}

function labelFor(scope: MemoryScope, ctx: MemoryContext): string {
  if (scope === "user") return "USER.md";
  if (scope === "memory-global") return "MEMORY.md";
  return `${basename(ctx.worktree)}/MEMORY.md`;
}

export function loadMemoryFile(scope: MemoryScope, ctx: MemoryContext): MemoryFile {
  const path = memoryFilePath(scope, ctx);
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";

  // CRLF (Notepad's default) would blow the char cap differently on Windows vs Linux.
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const text = redactMemoryText(normalized).text;
  return {
    scope,
    path,
    text,
    chars: text.length,
    cap: MEMORY_CAPS[scope],
    entries: parseEntries(text),
    label: labelFor(scope, ctx),
  };
}

export function loadMemory(ctx: MemoryContext): LoadedMemory {
  return {
    user: loadMemoryFile("user", ctx),
    global: loadMemoryFile("memory-global", ctx),
    project: loadMemoryFile("memory-project", ctx),
  };
}

export type MemoryWriteRequest = {
  scope: MemoryScope;
  action: "add" | "replace" | "remove";
  target?: string;
  content?: string;
  reason: string;
  durable: boolean;
  // The exact line `target` named when it was read. Without it, `target` matches whatever line
  // contains it now, which may be a line another writer rewrote since.
  expect?: string;
};

export type MemorySecretScan = {
  records: number;
  replacements: number;
  unreadable: number;
  byKind: SecretTally;
};

export function sanitizeMemoryWrite(req: MemoryWriteRequest): MemoryWriteRequest {
  return {
    ...req,
    target: req.target === undefined ? undefined : redactText(req.target).text,
    content: req.content === undefined ? undefined : redactText(req.content).text,
    reason: redactText(req.reason).text,
  };
}

function redactMemoryText(text: string): { text: string; found: SecretTally } {
  if (text.length === 0) return { text: "", found: {} };
  let found: SecretTally = {};
  const next = text.split("\n").map((line) => {
    const redacted = redactText(line);
    found = mergeTally(found, redacted.found);
    return redacted.text;
  });
  return { text: next.join("\n"), found };
}

export function listMemoryFilePaths(configDir: string): string[] {
  const dir = getMemoriesDir(configDir);
  if (!existsSync(dir)) return [];
  try {
    const paths: string[] = [];
    for (const name of ["USER.md", "MEMORY.md"] as const) {
      const path = join(dir, name);
      if (existsSync(path)) paths.push(path);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name, "MEMORY.md");
      if (existsSync(path)) paths.push(path);
    }
    return paths;
  } catch {
    return [];
  }
}

// A hold is one read and one atomic write of a file under its char cap, so a lock held past the
// wait belongs to a stuck holder, not a slow one.
const LOCK_WAIT_MS = 2_000;
// A holder that died between creating the lock and writing its pid leaves it empty for good.
const LOCK_EMPTY_GRACE_MS = 500;
const LOCK_BACKOFF_MS = [1, 2, 5, 10, 20, 50] as const;
const LOCK_OWNER_RE = /^([1-9]\d*) \S+$/;

// The lock is released when the body returns, so an async body would publish after release.
type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

type LockState =
  | { kind: "free" }
  | { kind: "held"; pid: number; owner: string }
  | { kind: "unwritten"; ageMs: number };

const heldByThisThread = new Set<string>();

class MemoryLockBusy extends Error {
  constructor(path: string, pid: number | undefined) {
    super(
      `memory_write refused: ${path} is locked by ${pid === undefined ? "another process" : `pid ${pid}`}; nothing was written.`,
    );
    this.name = "MemoryLockBusy";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// EPERM means the pid exists under another user.
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// An unlinked lock stays delete-pending on win32 while another process has it open, and opening
// it then fails with EPERM or EBUSY instead of ENOENT or EEXIST.
function isWin32DeletePending(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
}

function readLockState(lockPath: string): LockState {
  let mtimeMs: number;
  let text: string;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
    text = readFileSync(lockPath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "free" };
    if (isWin32DeletePending(error)) return { kind: "unwritten", ageMs: 0 };
    throw error;
  }
  const match = LOCK_OWNER_RE.exec(text);
  if (match === null) return { kind: "unwritten", ageMs: Date.now() - mtimeMs };
  return { kind: "held", pid: Number(match[1]), owner: text };
}

function lockIsStale(state: LockState): boolean {
  if (state.kind === "held") return !pidIsAlive(state.pid);
  if (state.kind === "unwritten") return state.ageMs > LOCK_EMPTY_GRACE_MS;
  return false;
}

function createLock(lockPath: string, owner: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || isWin32DeletePending(error)) {
      return false;
    }
    throw error;
  }
  // Closed at once. On win32 an open handle keeps an unlinked lock delete-pending, which blocks
  // the next create.
  try {
    writeSync(fd, `${owner}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function removeLock(lockPath: string): boolean {
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function acquireMemoryLock(path: string): string {
  const lockPath = `${path}.lock`;
  ensureOwnerOnlyDir(dirname(path));
  const owner = `${process.pid} ${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    if (createLock(lockPath, owner)) return owner;
    const state = readLockState(lockPath);
    // A live pid is never stolen from. A stopped holder (Ctrl-Z, a debugger) would resume and
    // publish text computed from its own read.
    if (lockIsStale(state) && removeLock(lockPath)) continue;
    if (Date.now() >= deadline) {
      throw new MemoryLockBusy(path, state.kind === "held" ? state.pid : undefined);
    }
    sleepSync(LOCK_BACKOFF_MS[Math.min(attempt, LOCK_BACKOFF_MS.length - 1)]);
  }
}

function releaseMemoryLock(path: string, owner: string): void {
  // A throw here would replace the commit's own result. A lock left behind names this pid and is
  // reclaimed once it exits.
  try {
    const state = readLockState(`${path}.lock`);
    if (state.kind === "held" && state.owner === owner) unlinkSync(`${path}.lock`);
  } catch {}
}

// Two waiters can both judge one dead lock stale, and the slower unlink then removes the faster
// waiter's new lock. Checking the owner right before the rename refuses a publish that lost it.
function publishMemoryFile(path: string, owner: string, text: string): void {
  const state = readLockState(`${path}.lock`);
  if (state.kind !== "held" || state.owner !== owner) {
    throw new MemoryLockBusy(path, state.kind === "held" ? state.pid : undefined);
  }
  atomicWriteFile(path, text);
}

function withMemoryLock<T>(
  path: string,
  body: (publish: (text: string) => void) => NotPromise<T>,
): T {
  if (heldByThisThread.has(path)) {
    throw new Error(
      `memory_write refused: ${path} is already being written by this process; nothing was written.`,
    );
  }
  for (let attempt = 1; ; attempt++) {
    const owner = acquireMemoryLock(path);
    heldByThisThread.add(path);
    try {
      return body((text) => publishMemoryFile(path, owner, text));
    } catch (error) {
      // Inside the body only publish throws MemoryLockBusy. The lock changed hands after the body's
      // read, so that read may be stale and is redone under a new lock.
      if (!(error instanceof MemoryLockBusy) || attempt === 2) throw error;
    } finally {
      heldByThisThread.delete(path);
      releaseMemoryLock(path, owner);
    }
  }
}

function redactMemoryFile(path: string, publish?: (text: string) => void): SecretTally | undefined {
  const raw = readFileSync(path, "utf8");
  const redacted = redactMemoryText(raw);
  if (redacted.text === raw) return undefined;
  publish?.(redacted.text);
  return redacted.found;
}

export function scanMemorySecrets(configDir: string, write: boolean): MemorySecretScan {
  const scan: MemorySecretScan = { records: 0, replacements: 0, unreadable: 0, byKind: {} };
  for (const path of listMemoryFilePaths(configDir)) {
    let found: SecretTally | undefined;
    try {
      found = write
        ? withMemoryLock(path, (publish) => redactMemoryFile(path, publish))
        : redactMemoryFile(path);
    } catch (error) {
      // A busy file is not skipped. A scrub that reported it clean could leave a secret in it.
      if (error instanceof MemoryLockBusy) throw error;
      scan.unreadable += 1;
      continue;
    }
    if (found === undefined) continue;
    scan.records += 1;
    for (const [kind, count] of Object.entries(found)) {
      if (count === undefined || count === 0) continue;
      scan.replacements += count;
      scan.byKind = mergeTally(scan.byKind, { [kind]: count });
    }
  }
  return scan;
}

function currentEntriesBlock(file: MemoryFile): string {
  const lines = [`Current entries (${file.entries.length}, ${file.chars} chars):`];
  for (const entry of file.entries) lines.push(`  ${entry.line}`);
  return lines.join("\n");
}

function findUniqueMatch(file: MemoryFile, target: string): MemoryEntry {
  if (target.length === 0) {
    throw new Error(`memory_write refused: "target" must not be empty.`);
  }
  const matches = file.entries.filter((entry) => entry.line.includes(target));
  if (matches.length === 0) {
    throw new Error(
      `memory_write refused: no entry contains "${truncate(target, 80)}".\n${currentEntriesBlock(file)}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `memory_write refused: "${truncate(target, 80)}" appears in ${matches.length} entries; include enough text to identify exactly one.`,
    );
  }
  return matches[0];
}

export class MemoryConflict extends Error {
  constructor(
    readonly file: MemoryFile,
    reason: string,
  ) {
    super(`memory_write conflict: ${reason} Nothing was written.\n${currentEntriesBlock(file)}`);
    this.name = "MemoryConflict";
  }
}

function targetIndex(file: MemoryFile, lines: string[], target: string, expect?: string): number {
  if (expect === undefined) return lines.indexOf(findUniqueMatch(file, target).line);
  const index = lines.indexOf(expect);
  if (index === -1) {
    throw new MemoryConflict(
      file,
      `"${truncate(expect, 80)}" changed or was removed in ${file.label} after it was read.`,
    );
  }
  return index;
}

function assertSingleLine(content: string): void {
  if (content.includes("\n")) {
    throw new Error(
      `memory_write refused: an entry must be a single line. Split this into separate "add" calls.`,
    );
  }
}

export function computeWrite(file: MemoryFile, raw: MemoryWriteRequest, today: string): string {
  const req = sanitizeMemoryWrite(raw);
  const lines = file.text.length === 0 ? [] : file.text.split("\n");

  if (req.action === "add") {
    if (req.content === undefined) {
      throw new Error(`memory_write refused: action "add" requires "content".`);
    }
    assertSingleLine(req.content);
    lines.push(`- [${today}] ${req.content}`);
  } else if (req.action === "replace") {
    if (req.target === undefined || req.content === undefined) {
      throw new Error(`memory_write refused: action "replace" requires "target" and "content".`);
    }
    assertSingleLine(req.content);
    lines[targetIndex(file, lines, req.target, req.expect)] = `- [${today}] ${req.content}`;
  } else {
    if (req.target === undefined) {
      throw new Error(`memory_write refused: action "remove" requires "target".`);
    }
    lines.splice(targetIndex(file, lines, req.target, req.expect), 1);
  }

  const nextText = lines.join("\n");
  if (nextText.length > file.cap) {
    const over = nextText.length - file.cap;
    throw new Error(
      `memory_write refused: ${file.scope} (${basename(file.path)}) would be ${nextText.length} chars, ` +
        `${over} over its ${file.cap}-char cap. Nothing was written.\n` +
        `Consolidate or remove an entry with action "replace"/"remove", then retry.\n${currentEntriesBlock(file)}`,
    );
  }
  return nextText;
}

export function applyWrite(
  req: MemoryWriteRequest,
  ctx: MemoryContext,
  today: string,
): { path: string; before: string; after: string } {
  const path = memoryFilePath(req.scope, ctx);
  return withMemoryLock(path, (publish) => {
    const file = loadMemoryFile(req.scope, ctx);
    const after = computeWrite(file, req, today);
    publish(after);
    return { path, before: file.text, after };
  });
}

function percentBudget(file: MemoryFile): string {
  const pct = Math.round((file.chars / file.cap) * 100);
  return `[${pct}% — ${file.chars}/${file.cap} chars]`;
}

function section(heading: string, file: MemoryFile): string {
  const body =
    file.entries.length === 0
      ? "(nothing recorded yet)"
      : file.entries.map((e) => e.line).join("\n");
  return `## ${heading} — ${file.label} ${percentBudget(file)}\n${body}`;
}

const MEMORY_TIER_INTRO =
  "Your own notes from earlier sessions, loaded once at session start and frozen for this session: a\n" +
  "write made now takes effect in the next session, not this one. You cannot edit these directly.";

function memoryFilesEmpty(memory: LoadedMemory): boolean {
  const isEmpty = (file: MemoryFile): boolean => file.text.trim().length === 0;
  return isEmpty(memory.user) && isEmpty(memory.global) && isEmpty(memory.project);
}

function memorySections(memory: LoadedMemory): string {
  return [
    section("About the user", memory.user),
    "",
    section("Global notes", memory.global),
    "",
    section("This project", memory.project),
  ].join("\n");
}

export function renderMemoryTier(memory: LoadedMemory): string {
  if (memoryFilesEmpty(memory)) return "";
  return ["# Memory", MEMORY_TIER_INTRO, "", memorySections(memory)].join("\n");
}

export function renderArchivistMemory(memory: LoadedMemory): string {
  if (memoryFilesEmpty(memory)) return "";
  return memorySections(memory);
}
