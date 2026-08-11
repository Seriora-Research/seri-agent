import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { getMemoriesDir } from "../config/paths";
import { projectKey } from "../permissions/store";
import { truncate } from "../truncate";

export type MemoryScope = "user" | "memory-global" | "memory-project";

// Character budgets for the WHOLE file (date tags included, §1b) — small enough that a session
// start never pays for more than a few hundred tokens of memory, deliberately per-scope rather
// than one shared pool so a chatty global note can't crowd out the user's own preferences.
export const MEMORY_CAPS: Record<MemoryScope, number> = {
  user: 1_375,
  "memory-global": 2_200,
  "memory-project": 2_200,
};

export type MemoryContext = { configDir: string; worktree: string };

// sha256 of projectKey(worktree), first 16 hex chars (64 bits). NOT a new project-identity
// function: projectKey (permissions/store.ts) already owns the resolve()+case-fold decision; this
// only makes its output usable as a directory name, the same way checkpoint.ts's
// checkpointStoreDir already digests it for the same reason.
export function projectDirToken(worktree: string): string {
  return createHash("sha256").update(projectKey(worktree)).digest("hex").slice(0, 16);
}

export function memoryFilePath(scope: MemoryScope, ctx: MemoryContext): string {
  const dir = getMemoriesDir(ctx.configDir);
  if (scope === "user") return join(dir, "USER.md");
  if (scope === "memory-global") return join(dir, "MEMORY.md");
  return join(dir, projectDirToken(ctx.worktree), "MEMORY.md");
}

// A line that doesn't match ENTRY_RE (a hand-written line, or the file's very first line before
// any entry was ever added) is preserved verbatim on write but reported with date "" — the file is
// hand-editable, and a line typed by hand must never be silently dropped by a later memory_write.
export type MemoryEntry = { date: string; text: string; line: string };
export type MemoryFile = {
  scope: MemoryScope;
  path: string;
  text: string;
  chars: number;
  cap: number;
  entries: MemoryEntry[];
  // basename(worktree) for a project file, the fixed filename otherwise — never the hash token or
  // the full path (renderMemoryTier's own guarantee). Computed at load time, here, because
  // renderMemoryTier only ever receives a LoadedMemory and has no ctx.worktree of its own to derive
  // it from.
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
  // Normalized on load, not left to parseEntries: a CRLF file (any Windows editor's default save)
  // would blow the char cap differently on Windows than on Linux, and a trailing "\n" (any editor
  // that adds one on save) would otherwise split into a phantom `{date:"",text:"",line:""}` entry
  // via text.split("\n") in parseEntries below — inflating `entries.length` in cap-refusal
  // messages, making section()'s own `entries.length === 0` check miss an otherwise-empty file,
  // and worst of all getting re-derived by computeWrite's own `text.split("\n")` on the very next
  // write, permanently baking a blank line into the middle of the file instead of it staying a
  // harmless trailing artifact.
  const text = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
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
  reason: string; // provenance tag: which turn/fact triggered this write — never written to the file itself (§1f)
  durable: boolean; // provenance tag: lasting fact/preference (true) vs session-scoped noise (false)
};

// The un-truncated "Current entries" block every refusal below carries, so the model (or a human
// at /memory diff) can see everything it might consolidate rather than guessing at what else is in
// the file.
function currentEntriesBlock(file: MemoryFile): string {
  const lines = [`Current entries (${file.entries.length}, ${file.chars} chars):`];
  for (const entry of file.entries) lines.push(`  ${entry.line}`);
  return lines.join("\n");
}

function findUniqueMatch(file: MemoryFile, target: string): MemoryEntry {
  // "".includes() is always true, so an unguarded empty target would match every entry — in a
  // file with exactly one entry, matches.length === 1 would pass silently below and
  // remove/overwrite it despite no genuine match. The schema (memory/tool.ts) already rejects an
  // empty target from a model call, but computeWrite is also reached from pending.ts's
  // approvePending/diffPending re-validation path against a `.pending` file read straight off
  // disk, which the schema never touches — this is the check that actually covers that path.
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

// Shared by the "add" and "replace" branches below — the one place that decides what counts as a
// disallowed newline and the one error message string, rather than two copy-pasted checks.
function assertSingleLine(content: string): void {
  if (content.includes("\n")) {
    throw new Error(
      `memory_write refused: an entry must be a single line. Split this into separate "add" calls.`,
    );
  }
}

// Pure. Returns the file's next full text, or throws — the caller does not branch on a result
// union, matching tools/edit.ts's own throw-on-ambiguity precedent (edit.ts:109-127). loop.ts
// already turns a thrown tool error into an `error-text` tool result the model reads in the same
// turn, so a throw here is how "the model consolidates in the same turn" (§1c) actually happens.
export function computeWrite(file: MemoryFile, req: MemoryWriteRequest, today: string): string {
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
    // The date is refreshed, not carried over: a replace is a modification, and staleness should
    // be legible from the date the same way a fresh "add" is.
    lines[index] = `- [${today}] ${req.content}`;
  } else {
    if (req.target === undefined) {
      throw new Error(`memory_write refused: action "remove" requires "target".`);
    }
    const match = findUniqueMatch(file, req.target);
    const index = lines.indexOf(match.line);
    lines.splice(index, 1);
  }

  // "\n" only, never CRLF, on every platform — a CRLF file would blow the char cap differently on
  // Windows than on Linux, making this test pass on two of three CI runners and not the third.
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

// mkdir 0o700 + write-then-rename + chmod 0o600 on non-win32, via atomicWriteFile.ts's shared
// helper (that module's own comment covers why the tmp filename is non-colliding) — this file
// holds the user's own stated preferences, and anything that can append to it steers future
// sessions.
export function applyWrite(
  req: MemoryWriteRequest,
  ctx: MemoryContext,
  today: string,
): { path: string; before: string; after: string } {
  const file = loadMemoryFile(req.scope, ctx);
  const after = computeWrite(file, req, today); // throws before anything below runs
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

// "" when all three files are empty/whitespace-only — this IS the B2 guarantee: buildVolatileTier
// (agents/systemPrompt.ts) composes this through joinTiers, whose filter(Boolean) drops an empty
// string, so a session with no memory yet renders byte-identically to today's prompt.
export function renderMemoryTier(memory: LoadedMemory): string {
  const isEmpty = (file: MemoryFile): boolean => file.text.trim().length === 0;
  if (isEmpty(memory.user) && isEmpty(memory.global) && isEmpty(memory.project)) return "";
  return [
    "# Memory",
    MEMORY_TIER_INTRO,
    "",
    section("About the user", memory.user),
    "",
    section("Global notes", memory.global),
    "",
    section("This project", memory.project),
  ].join("\n");
}
