import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Document, parseDocument, Scalar, YAMLMap } from "yaml";
import { atomicWriteFile } from "../atomicWriteFile";
import { projectKey } from "../permissions/store";


















export const HOOKS_TRUST_FILENAME = "hooks-trust.yaml";

export function hooksTrustPath(configDir: string): string {
  return join(configDir, HOOKS_TRUST_FILENAME);
}
















export function digestHooksDir(dir: string): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {



      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;



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




  if (current.size === 0) return { kind: "untrusted" };

  const stored = storedDigests(state.doc, projectKey(opts.dir));
  if (stored.size === 0) return { kind: "untrusted" };

  const changed = changedFiles(stored, current);
  return changed.length === 0 ? { kind: "trusted" } : { kind: "changed", files: changed };
}








export function trustHooksDir(
  configDir: string,
  dir: string,
  onWarning?: (message: string) => void,
): void {
  const state = readStore(configDir);
  if (state.status === "malformed") {



    onWarning?.(
      `could not parse ${hooksTrustPath(configDir)}, so the hooks directory was not trusted; fix or delete that file`,
    );
    return;
  }

  const doc = state.status === "missing" ? parseDocument(TEMPLATE) : state.doc;




  const hooks = doc.get("hooks");
  if (hooks instanceof YAMLMap) hooks.flow = false;
  const entry = doc.createNode(Object.fromEntries(digestHooksDir(dir)));
  entry.flow = false;
  doc.setIn(["hooks", projectKey(dir)], entry);
  atomicWriteFile(hooksTrustPath(configDir), String(doc));
}


export function untrustHooksDir(configDir: string, dir: string): boolean {
  const state = readStore(configDir);
  if (state.status !== "ok") return false;
  const hooks = state.doc.get("hooks");
  if (!(hooks instanceof YAMLMap)) return false;
  const removed = hooks.delete(projectKey(dir));
  if (removed) atomicWriteFile(hooksTrustPath(configDir), String(state.doc));
  return removed;
}
