import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Document, parseDocument, Scalar, YAMLMap } from "yaml";
import { atomicWriteFile } from "../atomicWriteFile";
import { projectKey } from "../permissions/store";

// Hooks are the one project-scoped extension that EXECUTES code, and `PreToolUse` fires ahead of
// the permission gate — including on `read_file`, which gate.ts's checkPermission allows for what
// it is, in every mode. So an ungated project hook is arbitrary code execution in `read-only`,
// the one mode whose entire promise is that nothing executes, reached by cloning a repository and
// asking the agent one question, with no prompt answered along the way. This store is the record
// of the answer that has to come first, and it is why the safety tier a session is running under
// stays something declared rather than assumed.
//
// The profile root's own `hooks/` (getHooksDir) needs no entry here: nothing arrives there by
// cloning a repository, so it is trusted by construction. Only the project scope needs a grant.
//
// Entries are keyed by the hooks DIRECTORY, through permissions/store.ts's projectKey — the same
// case fold, for the same NTFS/APFS reason — and never by the worktree the session was launched
// from. findProjectExtensionDir walks upward, so `repo/` and `repo/apps/cli/` resolve to the one
// `repo/.seri/hooks`; keying on the worktree would ask for a fresh review of an already-reviewed
// artifact every time the user starts seri from a different directory inside a monorepo, and a
// prompt that fires on something the user already answered is a prompt they learn to dismiss.
export const HOOKS_TRUST_FILENAME = "hooks-trust.yaml";

export function hooksTrustPath(configDir: string): string {
  return join(configDir, HOOKS_TRUST_FILENAME);
}

/** sha256 of every file under `dir`, keyed by its `/`-joined path relative to `dir`. */
// Every file, not only the ones hooks.yaml names, because a script's own `source ./common.sh`
// makes any neighbour part of what runs and no reading of the manifest settles which helpers
// count. The cost is accepted rather than worked around: an editor's swap file or a stray `.log`
// landing in the directory re-triggers the prompt, which is the direction to be wrong in.
//
// Recursive, and that is not tidiness. A walk one level deep leaves `lib/common.sh` outside the
// grant while a reviewed `block-dangerous.sh` can still source it, so an attacker ships a clean
// script, gets it trusted, and then edits the helper with the digest never moving. The claim this
// function exists to make is that the bytes reviewed are the bytes that run, and a shallow walk
// cannot make it.
//
// Keys are joined with "/" whatever the platform separator is, so a grant written on Windows still
// matches the same tree read on WSL or a Linux CI runner. A store keyed on "\\" would silently
// report every nested file as changed after a clone onto the other OS.
export function digestHooksDir(dir: string): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      // Unreadable, or not a directory at all. Neither is something a digest can describe, and
      // neither is a reason to fail the whole check — checkTrust reads an empty map as untrusted,
      // which is the safe answer.
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // Symlinks are followed for neither the walk nor the read. A link is a pointer to bytes
      // outside the directory, so digesting its target would pin something the grant does not
      // cover and could not re-check.
      if (entry.isDirectory()) {
        walk(path, key);
        continue;
      }
      if (!entry.isFile()) continue;
      let content: Buffer;
      try {
        content = readFileSync(path);
      } catch {
        continue;
      }
      digests.set(key, createHash("sha256").update(content).digest("hex"));
    }
  };
  walk(dir, "");
  return digests;
}

export type TrustVerdict =
  | { readonly kind: "trusted" }
  | { readonly kind: "untrusted" }
  // Names the files that moved, so the re-review prompt can show the diff the user actually has to
  // read instead of re-presenting a directory they already reviewed once.
  | { readonly kind: "changed"; readonly files: readonly string[] };

const TEMPLATE = `# seri — the project hook directories you have read and allowed to run.
#
# A hook is the one project-scoped extension that executes code, and a PreToolUse hook runs BEFORE
# the permission gate — including in read-only mode, whose whole promise is that nothing executes.
# So a hooks directory that arrived by cloning a repository runs nothing until it is listed here.
#
# Each entry is a sha256 of every file in that directory, taken when you approved it. Edit a script
# and seri asks again, because the answer you gave was about different bytes. hooks.yaml is in
# there too: it decides which script fires on which event and against which tools, so rewiring a
# lenient PostToolUse script onto PreToolUse changes what runs without touching a script.
#
# Deleting an entry revokes the grant. Comments survive when seri rewrites this file.

hooks: {}
`;

type StoreState = { status: "missing" } | { status: "malformed" } | { status: "ok"; doc: Document };

// "Malformed" is anything that cannot be trusted as the shape this module writes: a YAML syntax
// error, a document with no `hooks` map (a plain scalar parses fine and is neither), a `hooks` key
// holding something other than a map, or the read itself failing — existsSync is true for a
// directory and for a file this process cannot open, so it cannot predict whether the read will
// succeed. All of them degrade the same way, and the degradation is the safe direction on both
// sides: checkTrust reports untrusted, and the writers refuse to touch a file whose content they
// could not make sense of rather than overwriting an entry the user may still need.
function readStore(configDir: string): StoreState {
  const path = hooksTrustPath(configDir);
  if (!existsSync(path)) return { status: "missing" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { status: "malformed" };
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { status: "malformed" };
  if (!(doc.get("hooks") instanceof YAMLMap)) return { status: "malformed" };
  return { status: "ok", doc };
}

function storedDigests(doc: Document, key: string): Map<string, string> {
  const stored = new Map<string, string>();
  const node = doc.getIn(["hooks", key]);
  if (!(node instanceof YAMLMap)) return stored;
  for (const pair of node.items) {
    const name = pair.key instanceof Scalar ? pair.key.value : pair.key;
    const digest = pair.value instanceof Scalar ? pair.value.value : pair.value;
    if (typeof name === "string" && typeof digest === "string") stored.set(name, digest);
  }
  return stored;
}

// The full key sets, not the shared ones: a file ADDED to a reviewed directory is new executable
// content nobody read, and a file REMOVED can be the guard whose absence is the point.
function changedFiles(
  stored: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): string[] {
  const names = new Set([...stored.keys(), ...current.keys()]);
  return [...names].filter((name) => stored.get(name) !== current.get(name)).sort();
}

export function checkTrust(opts: {
  configDir: string;
  dir: string;
  onWarning?: (message: string) => void;
}): TrustVerdict {
  const state = readStore(opts.configDir);
  if (state.status === "malformed") {
    opts.onWarning?.(
      `could not parse ${hooksTrustPath(opts.configDir)}, so no project hooks are trusted; fix or delete that file`,
    );
    return { kind: "untrusted" };
  }
  if (state.status === "missing") return { kind: "untrusted" };

  const current = digestHooksDir(opts.dir);
  // A directory with nothing in it is untrusted, never trusted: with no files there is nothing for
  // a grant to have been ABOUT, so an empty digest matching an empty (or hand-written) entry would
  // be a vacuous yes. An unreadable directory arrives here as an empty map too, and gets the same
  // answer for the same reason.
  if (current.size === 0) return { kind: "untrusted" };

  const stored = storedDigests(state.doc, projectKey(opts.dir));
  if (stored.size === 0) return { kind: "untrusted" };

  const changed = changedFiles(stored, current);
  return changed.length === 0 ? { kind: "trusted" } : { kind: "changed", files: changed };
}

// The full 64-hex sha256, NOT the 12-hex truncation mcpGrantKey uses. That truncation rests on two
// premises, and neither one transfers here. The first is readability in a file people hand-edit —
// but nobody hand-writes a trust digest; `/hooks` computes and writes it, and the entry is opaque
// either way. The second is the threat model: over there the adversary is a server changing its
// own tool, so the digest only has to survive an honest change. Here the adversary AUTHORS the
// bytes in the repository you cloned, and a second preimage against 48 bits is GPU-hours of
// grinding — a real budget for someone shipping a payload — rather than a break of sha256.
export function trustHooksDir(
  configDir: string,
  dir: string,
  onWarning?: (message: string) => void,
): void {
  const state = readStore(configDir);
  if (state.status === "malformed") {
    // Reported, not silent: a caller that prints "trusted" over a write that never happened would
    // leave the user believing a grant exists, and the next session would ask again with no
    // explanation.
    onWarning?.(
      `could not parse ${hooksTrustPath(configDir)}, so the hooks directory was not trusted; fix or delete that file`,
    );
    return;
  }

  const doc = state.status === "missing" ? parseDocument(TEMPLATE) : state.doc;
  // Comment preservation is why this store parses a Document instead of round-tripping through
  // `parse`: only the one path below is touched, so the header, every other project's entry and
  // whatever the user wrote next to them survive verbatim. `.flow = false` keeps a freshly
  // populated `hooks: {}` in block style rather than inheriting the empty flow map's own.
  const hooks = doc.get("hooks");
  if (hooks instanceof YAMLMap) hooks.flow = false;
  const entry = doc.createNode(Object.fromEntries(digestHooksDir(dir)));
  entry.flow = false;
  doc.setIn(["hooks", projectKey(dir)], entry);
  atomicWriteFile(hooksTrustPath(configDir), String(doc));
}

/** True when an entry was actually removed. */
export function untrustHooksDir(configDir: string, dir: string): boolean {
  const state = readStore(configDir);
  if (state.status !== "ok") return false;
  const hooks = state.doc.get("hooks");
  if (!(hooks instanceof YAMLMap)) return false;
  const removed = hooks.delete(projectKey(dir));
  if (removed) atomicWriteFile(hooksTrustPath(configDir), String(state.doc));
  return removed;
}
