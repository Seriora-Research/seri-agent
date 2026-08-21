import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelProvider } from "@seri/model-catalog";
import { atomicWriteFile } from "../atomicWriteFile";
import type { PermissionMode } from "../gate/gate";

export type SessionState<TMessage = unknown> = {
  id: string;
  cwd: string;
  systemPrompt: string;
  permissionMode: PermissionMode;
  // Optional so every session written before the model was recorded still loads. Beside
  // permissionMode because it is the same kind of thing: a per-session setting, resolved once at
  // creation and then owned by the session rather than re-read from the environment on every
  // resume — which is what lets a future /model change stick.
  model?: string;
  // Same optionality reasoning as `model`, just above: a session written before this field existed
  // still loads. Absence means "no provider was ever explicitly requested" — whether because the
  // session predates this field or because nothing was ever picked — not a synthetic "groq" that
  // was never actually chosen. DEFAULT_PROVIDER is applied only at the point of actually routing,
  // never recorded here as if it were a real request.
  provider?: ModelProvider;
  messages: TMessage[];
};

type SessionHeader = Omit<SessionState, "messages">;

// `<sessionsDir>/<id>.jsonl`: line 1 is the header, every line after it is one message. Splitting
// them is what turns an ordinary save into an append — the header is small and rarely changes, the
// message log is large and, within one turn, only ever grows. Before this, saveSession re-serialized
// and rewrote every message seen so far on every call, and it is called once per tool-call round —
// an O(n) rewrite repeated O(n) times over a long turn.
function sessionPath(sessionsDir: string, id: string): string {
  return join(sessionsDir, `${id}.jsonl`);
}

function headerOf(state: SessionState): SessionHeader {
  return {
    id: state.id,
    cwd: state.cwd,
    systemPrompt: state.systemPrompt,
    permissionMode: state.permissionMode,
    model: state.model,
    provider: state.provider,
  };
}

// Keyed by the joined `<sessionsDir>/<id>.jsonl` path rather than the bare session id: a session
// id is only unique within one sessionsDir, and a single process legitimately touches more than
// one sessionsDir (the test suite does this throughout, reusing short ids like "older"/"legacy"
// across independent `mkdtempSync` dirs). Keying by id alone conflated those — a save for "older"
// in a fresh directory read stale tracking left behind by an unrelated earlier "older" in a
// different directory, and concluded nothing had changed when the file being saved to did not
// exist yet. loadSession seeds
// both maps from what it just read, so resuming a session and then saving appends only the messages
// made since — without that seed, the first save after a resume would either re-append every
// message already on disk or be mistaken for the very first save.
const persistedCounts = new Map<string, number>();
const persistedHeaders = new Map<string, string>();
// Byte length of what THIS process last wrote (append or full rewrite) to each path. Two
// `seri --resume`d processes sharing a session id each keep their own prevCount/sameHeader based
// only on what they themselves last read or wrote — the append fast path assumed that was still
// true of the file on disk, so one process's append landed on top of bytes the other had appended
// in the meantime, interleaving instead of merely losing one side's messages the way a full
// overwrite (this format's predecessor) would have. Comparing the file's CURRENT size against this
// is what tells "nothing else touched this file since my last write" apart from "something did."
const persistedSizes = new Map<string, number>();

export function saveSession(state: SessionState, sessionsDir: string): void {
  mkdirSync(sessionsDir, { recursive: true });

  const headerJson = JSON.stringify(headerOf(state));
  const path = sessionPath(sessionsDir, state.id);
  const prevCount = persistedCounts.get(path);
  const sameHeader = prevCount !== undefined && persistedHeaders.get(path) === headerJson;
  // The append fast path assumes the header it is appending onto is still on disk, AND that the
  // file's size still matches what this process itself last wrote — statSync in one call gives
  // both "does it exist" and "is it still what I last left it at" instead of two separate checks.
  let onDiskSize: number | undefined;
  try {
    onDiskSize = statSync(path).size;
  } catch {
    onDiskSize = undefined;
  }
  const fileExists = onDiskSize !== undefined;
  const sizeMatches = fileExists && persistedSizes.get(path) === onDiskSize;
  // Narrowed, not closed: statSync above and appendFileSync below are two syscalls, not one, so a
  // second process's write landing in between is still possible — same shape as checkpoint.ts's own
  // TOCTOU note on filterSafeToDelete, narrowed to the smallest gap available without interprocess
  // locking. A same-size external rewrite (astronomically unlikely for real conversation content —
  // it would need matching byte length AND get appended before this statSync fires) would also slip
  // past this check. Closing the window fully needs a per-session interprocess lock, which is real
  // machinery for a two-processes-resuming-the-same-id scenario the user has to actively create.

  if (sameHeader && sizeMatches && state.messages.length > prevCount) {
    // The hot path: nothing but new messages changed since the last save, so only they are
    // serialized — the messages already on disk are never touched.
    const appended = state.messages
      .slice(prevCount)
      .map((message) => `${JSON.stringify(message)}\n`)
      .join("");
    appendFileSync(path, appended);
    persistedSizes.set(path, (onDiskSize as number) + Buffer.byteLength(appended, "utf8"));
  } else if (!sameHeader || !sizeMatches || state.messages.length < prevCount || !fileExists) {
    // First save for this id in this process, a header field changed (e.g. /mode), a /rewind
    // shrink, or the on-disk size no longer matches what this process itself last wrote (another
    // process saved this same session id in the meantime) — none of those are expressible as an
    // append, so the whole file is rebuilt from what this process currently has.
    const content = `${[headerJson, ...state.messages.map((message) => JSON.stringify(message))].join("\n")}\n`;
    atomicWriteFile(path, content);
    persistedSizes.set(path, Buffer.byteLength(content, "utf8"));
  }
  // The remaining case — same header, same message count, same on-disk size — needs no write at all.

  persistedCounts.set(path, state.messages.length);
  persistedHeaders.set(path, headerJson);
}

export function loadSession<TMessage = unknown>(
  id: string,
  sessionsDir: string,
  // Called only when a torn trailing line was dropped (below) — never for the ordinary case, so a
  // caller that ignores it (the default) sees no behavior change from before this parameter existed.
  onTruncated: () => void = () => {},
): SessionState<TMessage> {
  const path = sessionPath(sessionsDir, id);
  if (!existsSync(path)) throw new Error(`Session "${id}" not found in ${sessionsDir}`);

  // headerLine is never undefined: saveSession always writes the header as the file's first line
  // before any message line, and this function only reaches here once existsSync has confirmed the
  // file — written by saveSession — is present.
  const raw = readFileSync(path, "utf8");
  const [headerLine, ...messageLines] = raw.split("\n").filter(Boolean) as [string, ...string[]];
  const header = JSON.parse(headerLine) as SessionHeader;

  const messages: TMessage[] = [];
  let truncated = false;
  for (const [index, line] of messageLines.entries()) {
    try {
      messages.push(JSON.parse(line) as TMessage);
    } catch (err) {
      // appendFileSync's write can be torn by a killed process or a full disk, and only ever at the
      // END of the file — every earlier line was already flushed by a prior, completed save. A
      // malformed line anywhere but last is real corruption, not a torn write, and still throws.
      if (index !== messageLines.length - 1) throw err;
      truncated = true;
    }
  }

  // Seeds saveSession's delta tracking so the NEXT save in this process appends rather than
  // re-persisting everything just read back — see the comment on persistedCounts above. Skipped
  // when the trailing line was dropped: appending onto a file whose last line is still the torn
  // fragment would concatenate the next save's first line onto it, corrupting that line too.
  // Leaving both maps unseeded makes saveSession's `sameHeader` check false next time, forcing the
  // full-rewrite path, which overwrites the torn fragment instead of appending past it.
  if (!truncated) {
    persistedCounts.set(path, messages.length);
    persistedHeaders.set(path, headerLine);
    persistedSizes.set(path, Buffer.byteLength(raw, "utf8"));
  } else {
    onTruncated();
  }

  return { ...header, messages };
}

export function findMostRecentSession(sessionsDir: string): string | undefined {
  if (!existsSync(sessionsDir)) return undefined;

  let mostRecentId: string | undefined;
  let mostRecentMtime = -Infinity;
  for (const file of readdirSync(sessionsDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const mtime = statSync(join(sessionsDir, file)).mtimeMs;
    if (mtime > mostRecentMtime) {
      mostRecentMtime = mtime;
      mostRecentId = file.slice(0, -".jsonl".length);
    }
  }
  return mostRecentId;
}
