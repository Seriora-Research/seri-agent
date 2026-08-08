import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Document, parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";

// NOT derived from WRITE_TOOL_NAMES, on purpose: a tool added to the gate must be opted IN here
// deliberately, never swept in by a set-difference. bash and powershell are excluded because a grant
// keyed on a tool NAME says nothing about what a shell command will do — approving one `bash` call
// because it read `ls -la` would silently pre-approve `rm -rf ./src` forever under the same entry.
// Claude Code scopes always-allow to a command PREFIX precisely to avoid this; that is PR C.
export const PERSISTABLE_TOOL_NAMES = ["write_file", "edit"] as const;
export const PERSISTABLE_TOOLS: ReadonlySet<string> = new Set(PERSISTABLE_TOOL_NAMES);

export function permissionsPath(configDir: string): string {
  return join(configDir, "permissions.yaml");
}

// Copied from checkpointStoreDir (checkpoint/checkpoint.ts:84-92) with the sha256 deliberately
// dropped. The load-bearing half of that function is the case fold, not the digest: NTFS and APFS
// are case-insensitive by default, so `C:\Users\x\Proj` and `C:\users\x\proj` are ONE directory and
// keying them separately gives one project two allowlists depending on how the path was typed —
// shell autocomplete, a symlink or a script assembling the path differently all get you there. The
// digest exists over there only because a path cannot be a directory name; here the key is a YAML
// map key, and a file whose keys are 16 hex characters cannot be hand-edited, which is the entire
// reason this file is YAML. Same residual accepted as over there, for the same two reasons: a
// case-sensitive APFS/NTFS volume with two projects differing only in capitalisation folds them
// into one allowlist.
//
// Not extracted into a shared helper and called from checkpointStoreDir: that would be an edit to
// working code this change does not need. If a third caller appears, extract it then.
export function projectKey(worktree: string): string {
  const resolved = resolve(worktree);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

export type Grants = {
  // Kept apart rather than pre-merged: `seri permissions list` has to show WHICH tier an entry is
  // in, because that is what tells a user where to edit, and a merged array cannot say.
  readonly global: readonly string[];
  readonly project: readonly string[];
  // Not the entries themselves — a count. A grant in a project you are not standing in is still a
  // grant you must be able to notice; printing all of them would be noise on every `list`.
  readonly otherProjects: number;
};

const TEMPLATE = `# seri — tools approved permanently, so seri stops asking.
#
# Written when you answer "a" at an approval prompt, and safe to edit by hand.
#   seri permissions list            what is in effect right now
#   seri permissions remove <tool>   revoke it
#
# Only write_file and edit may appear here. bash and powershell are refused, on read as well as on
# write: a grant keyed on a tool NAME says nothing about what a shell command will do, so an entry
# reading "bash" would hand over the shell permanently. Command-pattern grants are a later feature.
#
# Comments survive when seri rewrites this file. Use them: an entry that cannot say why it exists is
# an entry nobody later dares remove.

# Approved in every project. seri never writes here — move an entry up from \`projects\` by hand when
# you mean it everywhere, and delete it here to take it back.
global: []

# Approved only under the given project root. An answer of "a" lands here, never in \`global\`.
projects: {}
`;

type StoreState = { status: "missing" } | { status: "malformed" } | { status: "ok"; doc: Document };

// A file is "malformed" for this store's purposes whenever it cannot be trusted as the shape this
// module writes — a real YAML syntax error, a well-formed document missing the `global`/`projects`
// keys entirely (a plain-scalar document like `:::not yaml:::` parses without error but is neither),
// one whose keys are present with the wrong collection type (`projects: "hello"`, say), or the read
// itself failing (EACCES, or EISDIR when the path is a directory — `existsSync` is true for both,
// so it cannot be relied on to predict whether the read will succeed). All four degrade the same
// way: loadGrants returns empty and warns, rememberGrant refuses to touch the file rather than risk
// overwriting content it could not make sense of — or, for the I/O case, content it could not even
// read. Both keys are required rather than optional because this store's own writer never produces
// a file missing either — a file lacking one was not written by seri, and guessing at its shape is
// not worth the risk of a rememberGrant mutating content it does not understand.
function readStore(configDir: string): StoreState {
  const path = permissionsPath(configDir);
  if (!existsSync(path)) return { status: "missing" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { status: "malformed" };
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { status: "malformed" };
  const global = doc.get("global");
  const projects = doc.get("projects");
  if (!(global instanceof YAMLSeq)) return { status: "malformed" };
  if (!(projects instanceof YAMLMap)) return { status: "malformed" };
  return { status: "ok", doc };
}

function scalarStrings(seq: YAMLSeq): string[] {
  return seq.items
    .map((item) => (item instanceof Scalar ? item.value : item))
    .filter((value): value is string => typeof value === "string");
}

// The read-side filter — the load-bearing half of DECISION 2, not the prompt's write-side check.
// The file is hand-editable, so a name outside PERSISTABLE_TOOLS reaching this far (typed by hand,
// or by anything else that can write the config dir) is dropped rather than honoured, and named so
// the drop is not silent.
function extractToolList(node: unknown, path: string, onWarning: ((message: string) => void) | undefined): string[] {
  if (!(node instanceof YAMLSeq)) return [];
  const result: string[] = [];
  for (const value of scalarStrings(node)) {
    if (PERSISTABLE_TOOLS.has(value)) {
      result.push(value);
    } else {
      onWarning?.(
        `ignoring "${value}" in ${path}: only write_file and edit can be approved permanently — a grant keyed on a tool name says nothing about what a shell command will do`,
      );
    }
  }
  return result;
}

// The raw union, unfiltered by PERSISTABLE_TOOLS: used only to answer "does this grant already
// exist", where a hand-written invalid entry must not cause a duplicate write either.
function toolsInDoc(doc: Document, key: string): string[] {
  const global = doc.get("global");
  const list = doc.getIn(["projects", key]);
  const globalTools = global instanceof YAMLSeq ? scalarStrings(global) : [];
  const projectTools = list instanceof YAMLSeq ? scalarStrings(list) : [];
  return [...globalTools, ...projectTools];
}

export function loadGrants(configDir: string, worktree: string, onWarning?: (message: string) => void): Grants {
  const path = permissionsPath(configDir);
  const state = readStore(configDir);
  if (state.status === "missing") return { global: [], project: [], otherProjects: 0 };
  if (state.status === "malformed") {
    onWarning?.(`could not parse ${path}, so it was ignored`);
    return { global: [], project: [], otherProjects: 0 };
  }

  const { doc } = state;
  const global = extractToolList(doc.get("global"), path, onWarning);
  const key = projectKey(worktree);
  const projectsNode = doc.get("projects");
  let project: string[] = [];
  let otherProjects = 0;
  if (projectsNode instanceof YAMLMap) {
    for (const pair of projectsNode.items) {
      const k = pair.key instanceof Scalar ? pair.key.value : pair.key;
      if (typeof k !== "string") continue;
      if (k === key) project = extractToolList(pair.value, path, onWarning);
      else otherProjects += 1;
    }
  }
  return { global, project, otherProjects };
}

export function effectiveTools(grants: Grants): string[] {
  return [...new Set([...grants.global, ...grants.project])];
}

// Directory 0o700, file 0o600, write-then-rename — the shape of config/config.ts's writeConfig,
// copied rather than shared because the reason differs: config.json holds no secrets either way,
// but a world-writable allowlist is a local privilege-escalation vector on its own — anything that
// can append `write_file` to it makes seri stop asking, in every future run.
function writeDocument(doc: Document, configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(configDir, 0o700);
  const path = permissionsPath(configDir);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, String(doc), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

// Comment preservation is the dependency's justification and is therefore a contract. Only the
// exact path touched below is mutated, so every comment, every other project's entries and the
// user's own ordering survive verbatim — this is the whole reason for the `yaml` dependency over
// JSON. `.flow = false` on the map/seq this call touches is what keeps a freshly-populated
// `projects: {}`/entry list in the block style the populated example in the plan shows, rather than
// yaml's default of matching the empty flow collection's own style.
export function rememberGrant(configDir: string, worktree: string, tool: string, onWarning?: (message: string) => void): boolean {
  if (!PERSISTABLE_TOOLS.has(tool)) return false;
  const path = permissionsPath(configDir);
  const state = readStore(configDir);
  if (state.status === "malformed") {
    onWarning?.(`could not parse ${path}, so the grant was not saved; fix or delete that file`);
    return false;
  }

  const doc = state.status === "missing" ? parseDocument(TEMPLATE) : state.doc;
  const key = projectKey(worktree);
  if (toolsInDoc(doc, key).includes(tool)) return false;

  // A trailing same-line comment. Written so the entry says something; a user editing it to say WHY
  // is the point.
  const entry = doc.createNode(tool) as Scalar;
  entry.comment = ` added ${new Date().toISOString().slice(0, 10)} by seri`;

  let projectsMap = doc.get("projects");
  if (!(projectsMap instanceof YAMLMap)) {
    doc.set("projects", doc.createNode({}));
    projectsMap = doc.get("projects");
  }
  (projectsMap as YAMLMap).flow = false;

  const list = doc.getIn(["projects", key]);
  if (list instanceof YAMLSeq) {
    list.add(entry);
  } else {
    const seq = doc.createNode([entry]);
    seq.flow = false;
    doc.setIn(["projects", key], seq);
  }

  writeDocument(doc, configDir);
  return true;
}

export function forgetGrant(configDir: string, worktree: string, tool: string): { global: boolean; project: boolean } {
  const state = readStore(configDir);
  if (state.status !== "ok") return { global: false, project: false };

  const { doc } = state;
  const key = projectKey(worktree);
  const global = doc.get("global");
  const removedGlobal = global instanceof YAMLSeq ? removeFromSeq(global, tool) : false;
  const list = doc.getIn(["projects", key]);
  const removedProject = list instanceof YAMLSeq ? removeFromSeq(list, tool) : false;

  if (removedGlobal || removedProject) writeDocument(doc, configDir);
  return { global: removedGlobal, project: removedProject };
}

function removeFromSeq(seq: YAMLSeq, tool: string): boolean {
  const index = seq.items.findIndex((item) => (item instanceof Scalar ? item.value : item) === tool);
  if (index === -1) return false;
  seq.items.splice(index, 1);
  return true;
}
