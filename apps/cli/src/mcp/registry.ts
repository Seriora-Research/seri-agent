import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Document, parse, parseDocument, YAMLMap } from "yaml";
import { atomicWriteFile } from "../atomicWriteFile";
import { getMcpDir, MCP_DIRNAME } from "../config/paths";
import { messageOf } from "../errors";
import { type ExtensionSource, extensionScopes } from "../extensions/discovery";
import type { McpCatalog, McpEntry, McpRegistry, McpServerSpec, McpToolInfo } from "./types";

export type { McpEntry, McpRegistry } from "./types";

export const SERVERS_FILENAME = "servers.yaml";




export const NAME_SHAPE = /^[a-z0-9][a-z0-9-]*$/;





const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandEnvRefs(
  value: string,
  env: Record<string, string | undefined>,
): { text: string; missingVar?: string } {
  let missingVar: string | undefined;
  const text = value.replace(ENV_REF, (_match, varName: string) => {
    const v = env[varName];
    if (v === undefined) {
      missingVar = varName;
      return "";
    }
    return v;
  });
  return missingVar === undefined ? { text } : { text, missingVar };
}

function parseOneServer(opts: {
  name: string;
  raw: unknown;
  filePath: string;
  source: ExtensionSource;
  env: Record<string, string | undefined>;
}): { spec: McpServerSpec | undefined; warning: string | undefined } {
  const { name, filePath } = opts;
  const skip = (reason: string) => ({
    spec: undefined,
    warning: `${filePath}: server "${name}" was skipped: ${reason}`,
  });

  if (!NAME_SHAPE.test(name)) {
    return skip(
      'the name must be lowercase letters, digits and "-", starting with a letter or digit',
    );
  }
  if (typeof opts.raw !== "object" || opts.raw === null || Array.isArray(opts.raw)) {
    return skip("its entry is not a mapping of keys to values");
  }
  const fields = opts.raw as Record<string, unknown>;

  const rawUrl = fields.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return skip('"url" is missing');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return skip(`"${rawUrl}" is not a valid URL`);
  }
  if (parsedUrl.protocol !== "https:") {
    return skip(`"${rawUrl}" must be an https URL`);
  }

  const headers: Record<string, string> = {};
  const rawHeaders = fields.headers;
  if (rawHeaders !== undefined) {
    if (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders)) {
      return skip('"headers" is not a mapping of keys to values');
    }
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value !== "string") {
        return skip(`header "${key}" is not a string`);
      }
      const { text, missingVar } = expandEnvRefs(value, opts.env);


      if (missingVar !== undefined) {
        return skip(`header "${key}" references unset environment variable "${missingVar}"`);
      }
      headers[key] = text;
    }
  }

  return {
    spec: { name, url: rawUrl, headers, source: opts.source, filePath },
    warning: undefined,
  };
}



export function parseServersFile(opts: {
  text: string;
  filePath: string;
  source: ExtensionSource;
  env: Record<string, string | undefined>;
}): { specs: readonly McpServerSpec[]; warnings: readonly string[] } {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parse(opts.text);
  } catch (err) {
    warnings.push(`could not parse ${opts.filePath}: it is not valid YAML (${messageOf(err)})`);
    return { specs: [], warnings };
  }
  if (doc === null || doc === undefined) return { specs: [], warnings };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    warnings.push(`${opts.filePath} was skipped: it is not a mapping of keys to values`);
    return { specs: [], warnings };
  }
  const servers = (doc as Record<string, unknown>).servers;
  if (servers === undefined) return { specs: [], warnings };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    warnings.push(`${opts.filePath}: "servers" is not a mapping of keys to values`);
    return { specs: [], warnings };
  }

  const specs: McpServerSpec[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const { spec, warning } = parseOneServer({
      name,
      raw,
      filePath: opts.filePath,
      source: opts.source,
      env: opts.env,
    });
    if (warning !== undefined) warnings.push(warning);
    if (spec !== undefined) specs.push(spec);
  }
  return { specs, warnings };
}

function catalogCachePath(configDir: string, server: string): string {
  return join(getMcpDir(configDir), "catalog", `${server}.json`);
}

function isMcpCatalog(value: unknown): value is McpCatalog {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.server !== "string" || typeof v.fetchedAt !== "string") return false;
  if (!Array.isArray(v.tools)) return false;
  return v.tools.every((tool): tool is McpToolInfo => {
    if (typeof tool !== "object" || tool === null) return false;
    const t = tool as Record<string, unknown>;
    return (
      typeof t.name === "string" &&
      typeof t.toolName === "string" &&
      typeof t.description === "string"
    );
  });
}



export function writeCatalogCache(configDir: string, catalog: McpCatalog): void {
  atomicWriteFile(catalogCachePath(configDir, catalog.server), JSON.stringify(catalog, null, 2));
}




export function deleteCatalogCache(configDir: string, server: string): void {
  const path = catalogCachePath(configDir, server);
  if (existsSync(path)) unlinkSync(path);
}



export function readCatalogCache(
  configDir: string,
  server: string,
  onWarning: (message: string) => void,
): McpCatalog | undefined {
  const path = catalogCachePath(configDir, server);
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    onWarning(`could not read the cached catalog ${path}: ${messageOf(err)}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    onWarning(`could not parse the cached catalog ${path}: ${messageOf(err)}`);
    return undefined;
  }
  if (!isMcpCatalog(parsed)) {
    onWarning(`the cached catalog ${path} is not the expected shape, so it was ignored`);
    return undefined;
  }
  return parsed;
}









export function loadMcpRegistry(opts: {
  worktree: string;
  configDir: string;
  onWarning: (message: string) => void;
}): Map<string, McpEntry> {
  const registry = new Map<string, McpEntry>();
  const scopes = extensionScopes({
    worktree: opts.worktree,
    configDir: opts.configDir,
    dirname: MCP_DIRNAME,
  });

  for (const scope of scopes) {
    const filePath = join(scope.dir, SERVERS_FILENAME);
    if (!existsSync(filePath)) continue;
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      opts.onWarning(`could not read ${filePath}: ${messageOf(err)}`);
      continue;
    }
    const { specs, warnings } = parseServersFile({
      text,
      filePath,
      source: scope.source,
      env: process.env,
    });
    for (const warning of warnings) opts.onWarning(warning);
    for (const spec of specs) {
      registry.set(spec.name, {
        spec,
        catalog: readCatalogCache(opts.configDir, spec.name, opts.onWarning),
      });
    }
  }
  return registry;
}



export function findMcpTool(
  registry: McpRegistry,
  toolName: string,
): { entry: McpEntry; tool: McpToolInfo } | undefined {
  for (const entry of registry.values()) {
    const tool = entry.catalog?.tools.find((t) => t.toolName === toolName);
    if (tool !== undefined) return { entry, tool };
  }
  return undefined;
}


function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}




export function toolFingerprint(tool: McpToolInfo): string {
  const canonical = canonicalize({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}



export function grantFingerprint(registry: McpRegistry, toolName: string): string | undefined {
  const found = findMcpTool(registry, toolName);
  return found === undefined ? undefined : toolFingerprint(found.tool);
}

function readServersDoc(filePath: string): Document {
  if (!existsSync(filePath)) return new Document({ servers: {} });
  const doc = parseDocument(readFileSync(filePath, "utf8"));
  if (doc.errors.length > 0) {
    throw new Error(`could not parse ${filePath}, so the file was not changed; fix or delete it`);
  }
  return doc;
}




export function addServerToFile(
  filePath: string,
  server: { name: string; url: string; headers: Readonly<Record<string, string>> },
): void {
  const doc = readServersDoc(filePath);
  let serversNode = doc.get("servers");
  if (!(serversNode instanceof YAMLMap)) {
    if (serversNode !== undefined) {
      throw new Error(`${filePath}: "servers" is not a mapping, so the file was not changed`);
    }
    doc.set("servers", doc.createNode({}));
    serversNode = doc.get("servers");
  }
  (serversNode as YAMLMap).set(
    server.name,
    doc.createNode({ url: server.url, headers: server.headers }),
  );
  atomicWriteFile(filePath, String(doc));
}



export function removeServerFromFile(filePath: string, name: string): boolean {
  if (!existsSync(filePath)) return false;
  const doc = readServersDoc(filePath);
  const serversNode = doc.get("servers");
  if (!(serversNode instanceof YAMLMap)) return false;
  const removed = serversNode.delete(name);
  if (removed) atomicWriteFile(filePath, String(doc));
  return removed;
}
