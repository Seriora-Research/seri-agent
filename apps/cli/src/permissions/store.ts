import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Document, parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";
import { ensureOwnerOnlyDir } from "../atomicWriteFile";
import { foldsCase } from "../caseFold";
import { parseAutoModeOnBlock, type AutoModeOnBlock } from "../gate/classifier";
import type { PathDenial } from "../gate/gate";
import { isMcpGrantKey, isMcpToolName, mcpGrantKey, parseMcpGrantKey } from "../mcp/types";






export const PERSISTABLE_TOOL_NAMES = ["write_file", "edit"] as const;
export const PERSISTABLE_TOOLS: ReadonlySet<string> = new Set(PERSISTABLE_TOOL_NAMES);









export function isPersistableTool(tool: string): boolean {
  return PERSISTABLE_TOOLS.has(tool) || isMcpToolName(tool);
}

export const PERMISSIONS_FILENAME = "permissions.yaml";

export function permissionsPath(configDir: string): string {
  return join(configDir, PERMISSIONS_FILENAME);
}














export function projectKey(worktree: string): string {
  const resolved = resolve(worktree);
  // NTFS/APFS fold case; ext4 does not.
  return foldsCase() ? resolved.toLowerCase() : resolved;
}

export type Grants = {


  readonly global: readonly string[];
  readonly project: readonly string[];


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
# the classifier's reason attached). A non-TTY run is always deny.

# Approved in every project. seri never writes here — move an entry up from \`projects\` by hand when
# you mean it everywhere, and delete it here to take it back.
global: []

# Approved only under the given project root. An answer of "a" lands here, never in \`global\`.
projects: {}

# Search roots glob, grep, read_file, and write_file must not be pointed at. A missing
# path still comes back as a permission denial, not as "path not found". A search rooted
# above a denied tree still descends into it. seri never writes here.
#   - glob(/secret/**)
#   - read_file(.env)
deny: []
`;

type StoreState = { status: "missing" } | { status: "malformed" } | { status: "ok"; doc: Document };

type YamlStore =
  | { status: "missing" }
  | { status: "unreadable"; path: string }
  | { status: "parsed"; path: string; doc: Document };

function parseYamlStore(configDir: string): YamlStore {
  const path = permissionsPath(configDir);
  if (!existsSync(path)) return { status: "missing" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { status: "unreadable", path };
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { status: "unreadable", path };
  return { status: "parsed", path, doc };
}












function readStore(configDir: string): StoreState {
  const parsed = parseYamlStore(configDir);
  if (parsed.status === "missing") return { status: "missing" };
  if (parsed.status === "unreadable") return { status: "malformed" };
  const global = parsed.doc.get("global");
  const projects = parsed.doc.get("projects");
  if (!(global instanceof YAMLSeq)) return { status: "malformed" };
  if (!(projects instanceof YAMLMap)) return { status: "malformed" };
  return { status: "ok", doc: parsed.doc };
}

function scalarStrings(seq: YAMLSeq): string[] {
  return seq.items
    .map((item) => (item instanceof Scalar ? item.value : item))
    .filter((value): value is string => typeof value === "string");
}







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

const DENIAL_ENTRY = /^([A-Za-z0-9_]+)\((.+)\)$/;



const DENIABLE_TOOLS: ReadonlySet<string> = new Set(["read_file", "glob", "grep", "write_file"]);

function parseDenialEntry(value: string): PathDenial | undefined {
  const match = DENIAL_ENTRY.exec(value);
  if (match === null) return undefined;
  const tool = match[1];
  const pattern = match[2];
  if (tool === undefined || pattern === undefined) return undefined;
  return { tool, pattern };
}

function yamlSeqValue(item: unknown): unknown {
  return item instanceof Scalar ? item.value : item;
}

function describeDenyEntry(value: unknown): string {
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return "a boolean";
  if (value === null || value === undefined) return "null";
  if (value instanceof YAMLSeq) return "a list";
  return "an object";
}








export function loadDenials(
  configDir: string,
  onWarning?: (message: string) => void,
): PathDenial[] {
  const parsed = parseYamlStore(configDir);
  if (parsed.status === "missing") return [];
  if (parsed.status === "unreadable") {
    onWarning?.(`could not parse ${parsed.path}, so path denials were ignored`);
    return [];
  }

  const node = parsed.doc.get("deny");
  if (node === undefined || node === null) return [];
  if (!(node instanceof YAMLSeq)) {
    onWarning?.(`ignoring deny in ${parsed.path}: expected a list of tool(pattern) entries`);
    return [];
  }

  const result: PathDenial[] = [];
  for (let index = 0; index < node.items.length; index++) {
    const value = yamlSeqValue(node.items[index]);
    if (typeof value !== "string") {
      onWarning?.(
        `ignoring deny[${index}] in ${parsed.path}: expected a tool(pattern) string, not ${describeDenyEntry(value)}`,
      );
      continue;
    }
    const entry = parseDenialEntry(value);
    if (entry === undefined) {
      onWarning?.(
        `ignoring deny[${index}] "${value}" in ${parsed.path}: deny entries must look like tool(pattern), e.g. glob(/secret/**)`,
      );
      continue;
    }
    if (!DENIABLE_TOOLS.has(entry.tool)) {
      onWarning?.(
        `ignoring deny[${index}] "${value}" in ${parsed.path}: deny entries must name a tool with a path argument (read_file, glob, grep, write_file)`,
      );
      continue;
    }
    result.push(entry);
  }
  return result;
}




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





function writeDocument(doc: Document, configDir: string): void {
  ensureOwnerOnlyDir(configDir);
  const path = permissionsPath(configDir);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, String(doc), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}













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
