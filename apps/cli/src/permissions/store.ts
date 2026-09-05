import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Document, parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";
import { ensureOwnerOnlyDir } from "../atomicWriteFile";
import { foldsCase } from "../caseFold";
import { parseAutoModeOnBlock, type AutoModeOnBlock } from "../gate/classifier";
import { isMcpGrantKey, isMcpToolName, mcpGrantKey, parseMcpGrantKey } from "../mcp/types";

// NOT derived from WRITE_TOOL_NAMES, on purpose: a tool added to the gate must be opted IN here
// deliberately, never swept in by a set-difference. bash and powershell are excluded because a grant
// keyed on a tool NAME says nothing about what a shell command will do — approving one `bash` call
// because it read `ls -la` would silently pre-approve `rm -rf ./src` forever under the same entry.
// Claude Code scopes always-allow to a command PREFIX precisely to avoid this; that is PR C.
export const PERSISTABLE_TOOL_NAMES = ["write_file", "edit"] as const;
export const PERSISTABLE_TOOLS: ReadonlySet<string> = new Set(PERSISTABLE_TOOL_NAMES);

// The single answer to "may this tool be remembered permanently at all" — as distinct from HOW it
// gets remembered, which rememberGrant's own fingerprint branch below still owns. This used to be
// written three times: at both approval-prompt call sites in cli.ts (their `offersAlways`) and
// again inside rememberGrant's own whether-check. Three independent copies of one boolean rule
// meant a negative control could only prove one copy at a time was in sync with this file — a rule
// stated once cannot be half-found. The prompt's `[a]lways` offer and the store's own acceptance
// MUST agree on this exact question: a mismatch is either a prompt offering an answer the store
// silently discards, or a grant the UI never gave anyone a way to make.
export function isPersistableTool(tool: string): boolean {
  return PERSISTABLE_TOOLS.has(tool) || isMcpToolName(tool);
}

export const PERMISSIONS_FILENAME = "permissions.yaml";

export function permissionsPath(configDir: string): string {
  return join(configDir, PERMISSIONS_FILENAME);
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
// The case-fold decision itself now lives in caseFold.ts (`config/paths.ts`'s profile-name
// handling became the third caller this comment used to wait for).
export function projectKey(worktree: string): string {
  const resolved = resolve(worktree);
  return foldsCase() ? resolved.toLowerCase() : resolved;
}

export type Grants = {
  // Kept apart rather than pre-merged: `/permissions` has to show WHICH tier an entry is
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
#   /permissions                     what is in effect right now; revokes a \`projects\` entry.
#                                     A \`global\` entry only comes back out by editing it here.
#
# write_file and edit may appear here by name. bash and powershell are refused, on read as well as
# on write: a grant keyed on a tool NAME says nothing about what a shell command will do, so an
# entry reading "bash" would hand over the shell permanently. Command-pattern grants are a later
# feature.
#
# An MCP tool may appear here too, as \`mcp_<server>_<tool>@<digest>\`. The @ suffix is a
# fingerprint over that tool's name, description, and input schema at the moment you approved it —
# a server is a third party, and its name and schema together are the only contract you were shown.
# Change the tool on the server's end and the digest stops matching, so seri asks again instead of
# trusting the old answer against a tool you never actually saw.
#
# Comments survive when seri rewrites this file. Use them: an entry that cannot say why it exists is
# an entry nobody later dares remove.
#
# autoModeOnBlock: deny
# In auto mode a classifier block is deny (default) or ask (the ordinary permission prompt, with
# the classifier's reason attached).

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
// The file is hand-editable, so a name outside PERSISTABLE_TOOLS and not a validly-shaped MCP
// grant key reaching this far (typed by hand, or by anything else that can write the config dir)
// is dropped rather than honoured, and named so the drop is not silent. A malformed digest
// (wrong length, non-hex) fails isMcpGrantKey the same way an unknown built-in name fails
// PERSISTABLE_TOOLS — both are "not a shape this store ever wrote".
function extractToolList(
  node: unknown,
  path: string,
  onWarning: ((message: string) => void) | undefined,
): string[] {
  if (!(node instanceof YAMLSeq)) return [];
  const result: string[] = [];
  for (const value of scalarStrings(node)) {
    if (PERSISTABLE_TOOLS.has(value) || isMcpGrantKey(value)) {
      result.push(value);
    } else {
      onWarning?.(
        `ignoring "${value}" in ${path}: only write_file, edit, and a valid mcp_<server>_<tool>@<digest> grant can be approved permanently — a grant keyed on a bare tool name says nothing about what a shell command will do, and an MCP grant is only meaningful bound to the contract's fingerprint`,
      );
    }
  }
  return result;
}

// The bare tool name an entry is FOR, stripping an MCP grant's `@<digest>` suffix — a built-in
// entry has no suffix to strip, so it passes through unchanged. This is the comparison key for
// "is there already a grant for this tool", independent of which digest it carries.
function bareToolName(entry: string): string {
  return parseMcpGrantKey(entry)?.toolName ?? entry;
}

export function loadGrants(
  configDir: string,
  worktree: string,
  onWarning?: (message: string) => void,
): Grants {
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

export function loadAutoModeOnBlock(
  configDir: string,
  onWarning?: (message: string) => void,
): AutoModeOnBlock {
  const state = readStore(configDir);
  if (state.status !== "ok") return "deny";
  const raw = state.doc.get("autoModeOnBlock");
  const value = raw instanceof Scalar ? raw.value : raw;
  if (value === undefined || value === null) return "deny";
  if (value !== "ask" && value !== "deny") {
    onWarning?.(`ignoring autoModeOnBlock ${JSON.stringify(value)}: expected "ask" or "deny"`);
  }
  return parseAutoModeOnBlock(value);
}

// Directory 0o700, file 0o600, write-then-rename — the shape of config/config.ts's writeConfig,
// copied rather than shared because the reason differs: config.json holds no secrets either way,
// but a world-writable allowlist is a local privilege-escalation vector on its own — anything that
// can append `write_file` to it makes seri stop asking, in every future run.
function writeDocument(doc: Document, configDir: string): void {
  ensureOwnerOnlyDir(configDir);
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
// `fingerprint` is required for an `mcp_` name and refused for a built-in one: a digest on a
// built-in would mean nothing (there is no third-party contract to pin), and an mcp_ grant with
// no digest is exactly the unbound rug-pull-prone grant this design exists to stop. bash and
// powershell are refused either way, by isPersistableTool's own whether-check below — this
// function no longer asks that question itself, only HOW a tool that may be persisted at all
// gets written.
export function rememberGrant(
  configDir: string,
  worktree: string,
  tool: string,
  onWarning?: (message: string) => void,
  fingerprint?: string,
): boolean {
  if (!isPersistableTool(tool)) return false;
  const mcp = isMcpToolName(tool);
  let value: string;
  if (mcp) {
    if (fingerprint === undefined) return false;
    value = mcpGrantKey(tool, fingerprint);
  } else {
    if (fingerprint !== undefined) return false;
    value = tool;
  }
  const path = permissionsPath(configDir);
  const state = readStore(configDir);
  if (state.status === "malformed") {
    onWarning?.(`could not parse ${path}, so the grant was not saved; fix or delete that file`);
    return false;
  }

  const doc = state.status === "missing" ? parseDocument(TEMPLATE) : state.doc;
  const key = projectKey(worktree);

  // Compared on the bare tool name, not the full entry: a stale entry for the same tool under an
  // old digest must be REPLACED, not left alongside a fresh one, or the old contract keeps
  // authorising the call. An exact match (same tool, same digest) is a true no-op. The stale
  // entry can live in EITHER tier: rememberGrant only ever writes the project tier, but the
  // template's own header invites hand-editing global, so a stale global entry is reachable —
  // and removing only from the project sequence would leave that one sitting there, authorising
  // calls against the old contract alongside the fresh project grant.
  const globalSeq = doc.get("global");
  const projectSeq = doc.getIn(["projects", key]);
  const globalStale =
    globalSeq instanceof YAMLSeq
      ? scalarStrings(globalSeq).find((existing) => bareToolName(existing) === tool)
      : undefined;
  const projectStale =
    projectSeq instanceof YAMLSeq
      ? scalarStrings(projectSeq).find((existing) => bareToolName(existing) === tool)
      : undefined;
  if (globalStale === value || projectStale === value) return false;

  if (globalStale !== undefined && globalSeq instanceof YAMLSeq) {
    removeFromSeq(globalSeq, globalStale);
  }
  if (projectStale !== undefined && projectSeq instanceof YAMLSeq) {
    removeFromSeq(projectSeq, projectStale);
  }

  // A trailing same-line comment. Written so the entry says something; a user editing it to say WHY
  // is the point.
  const entry = doc.createNode(value) as Scalar;
  entry.comment = ` added ${new Date().toISOString().slice(0, 10)} by seri`;

  let projectsMap = doc.get("projects");
  if (!(projectsMap instanceof YAMLMap)) {
    doc.set("projects", doc.createNode({}));
    projectsMap = doc.get("projects");
  }
  (projectsMap as YAMLMap).flow = false;

  const updatedList = doc.getIn(["projects", key]);
  if (updatedList instanceof YAMLSeq) {
    updatedList.add(entry);
  } else {
    const seq = doc.createNode([entry]);
    seq.flow = false;
    doc.setIn(["projects", key], seq);
  }

  writeDocument(doc, configDir);
  return true;
}

// `scope` is required, not defaulted: "project" is for a caller (the TUI's /permissions panel)
// that only ever showed the project-tier entry as removable — a tool granted in both tiers must
// keep its global pre-approval when removed from there, or the removal contradicts what the row
// told the user. `/permissions` remove uses "both" when the user asked to stop auto-approving a
// tool entirely; its message reports each tier it actually touched.
export function forgetGrant(
  configDir: string,
  worktree: string,
  tool: string,
  scope: "project" | "both",
  onWarning?: (message: string) => void,
): { global: boolean; project: boolean } {
  const path = permissionsPath(configDir);
  const state = readStore(configDir);
  if (state.status === "missing") return { global: false, project: false };
  if (state.status === "malformed") {
    onWarning?.(`could not parse ${path}, so nothing could be removed; fix or delete that file`);
    return { global: false, project: false };
  }

  const { doc } = state;
  const key = projectKey(worktree);
  const global = doc.get("global");
  const removedGlobal =
    scope === "both" && global instanceof YAMLSeq ? removeFromSeq(global, tool) : false;
  const projectsNode = doc.get("projects");
  const list = doc.getIn(["projects", key]);
  const removedProject = list instanceof YAMLSeq ? removeFromSeq(list, tool) : false;
  // Prune the project's key entirely once its list is empty, rather than leaving `key: []`
  // behind: an orphaned empty list would still count toward loadGrants' otherProjects below
  // forever, and it clutters the hand-editable file with an entry nobody put there on purpose.
  if (
    removedProject &&
    list instanceof YAMLSeq &&
    list.items.length === 0 &&
    projectsNode instanceof YAMLMap
  ) {
    projectsNode.delete(key);
  }

  if (removedGlobal || removedProject) writeDocument(doc, configDir);
  return { global: removedGlobal, project: removedProject };
}

function removeFromSeq(seq: YAMLSeq, tool: string): boolean {
  const index = seq.items.findIndex(
    (item) => (item instanceof Scalar ? item.value : item) === tool,
  );
  if (index === -1) return false;
  seq.items.splice(index, 1);
  return true;
}
