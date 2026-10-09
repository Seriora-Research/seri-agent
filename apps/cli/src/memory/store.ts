import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
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

export function scanMemorySecrets(configDir: string, write: boolean): MemorySecretScan {
  const scan: MemorySecretScan = { records: 0, replacements: 0, unreadable: 0, byKind: {} };
  for (const path of listMemoryFilePaths(configDir)) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      scan.unreadable += 1;
      continue;
    }
    const redacted = redactMemoryText(raw);
    if (redacted.text === raw) continue;
    if (write) {
      try {
        atomicWriteFile(path, redacted.text);
      } catch {
        scan.unreadable += 1;
        continue;
      }
    }
    scan.records += 1;
    for (const [kind, count] of Object.entries(redacted.found)) {
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
    const match = findUniqueMatch(file, req.target);
    const index = lines.indexOf(match.line);

    lines[index] = `- [${today}] ${req.content}`;
  } else {
    if (req.target === undefined) {
      throw new Error(`memory_write refused: action "remove" requires "target".`);
    }
    const match = findUniqueMatch(file, req.target);
    const index = lines.indexOf(match.line);
    lines.splice(index, 1);
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
  const file = loadMemoryFile(req.scope, ctx);
  const after = computeWrite(file, req, today);
  atomicWriteFile(file.path, after);
  return { path: file.path, before: file.text, after };
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
