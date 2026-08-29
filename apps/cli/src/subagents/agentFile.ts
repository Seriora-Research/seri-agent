import { basename } from "node:path";
import type { ModelProvider } from "@seri/model-catalog";
import { parse } from "yaml";
import { READ_ONLY_TOOL_NAMES, type ToolName, toolDefinitions } from "../provider/tools";
import { type AgentSource, type AgentSpec, composeAddendum } from "./registry";

// `skipped` carries the one reason the file was refused, already naming it. `spec` carries the
// notes that did not stop it loading. A malformed file is never a throw: session start does not
// fail because of an agent file.
export type AgentFileOutcome =
  | { readonly kind: "spec"; readonly spec: AgentSpec; readonly warnings: readonly string[] }
  | { readonly kind: "skipped"; readonly warning: string };

// Cursor/Claude Code names folded onto seri's, keyed lowercase so both vocabularies are matched
// case-insensitively. Every value is a key of toolDefinitions, which is what keeps
// DISPATCH_TOOL_NAME (not a key of it) unnameable here no matter what a file asks for.
const TOOL_ALIASES: Readonly<Record<string, ToolName>> = {
  read_file: "read_file",
  write_file: "write_file",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  bash: "bash",
  powershell: "powershell",
  read: "read_file",
  write: "write_file",
};

// Cursor's `model: some-id[effort=high]`. The bracket block is stripped from the id and its
// `effort=` param read out, so a file can pin an effort tier to the model it pins.
const MODEL_PARAMS = /^([^[]*)\[([^\]]*)\]\s*$/;

// The leading `---` fence, tolerant of CRLF because these files are edited on Windows too. A file
// without one is not an agent definition: the format is Markdown WITH YAML frontmatter, and a
// stray note dropped into agents/ must not load as an agent holding every tool seri has.
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const NAME_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

function skip(filePath: string, reason: string): AgentFileOutcome {
  return { kind: "skipped", warning: `agent file ${filePath} was skipped: ${reason}` };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

// A YAML list or a comma-separated plain scalar — Cursor's own files use both. `undefined` means
// the key was absent; an empty array means it was present and said nothing this parser can use,
// which is a different fact and gets a different answer below.
function readToolEntries(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string");
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseAgentFile(opts: {
  filePath: string;
  text: string;
  source: Exclude<AgentSource, "builtin">;
  /** Rejects a name colliding with a built-in, a routing target or a catalog command. */
  isReserved: (name: string) => boolean;
  /** Resolves `model:` to a complete pair, or undefined. Injected so this module stays free of the
   *  catalog and testable on text alone. */
  resolveModel: (id: string) => { model: string; provider: ModelProvider } | undefined;
}): AgentFileOutcome {
  const { filePath } = opts;
  const fence = FRONTMATTER.exec(opts.text);
  if (fence === null) return skip(filePath, "it has no YAML frontmatter block");

  let front: unknown;
  try {
    front = parse(fence[1] ?? "");
  } catch (err) {
    return skip(filePath, `its frontmatter is not valid YAML (${(err as Error).message})`);
  }
  if (typeof front !== "object" || front === null || Array.isArray(front)) {
    return skip(filePath, "its frontmatter is not a mapping of keys to values");
  }
  // Every key this parser does not read — `is_background`, `permissionMode`, anything a future
  // harness adds — is tolerated and ignored by never being looked up.
  const fields = front as Record<string, unknown>;
  const warnings: string[] = [];

  const name = (readString(fields.name) ?? basename(filePath, ".md")).toLowerCase();
  if (!NAME_SHAPE.test(name)) {
    return skip(
      filePath,
      `"${name}" is not a usable agent name (lowercase letters, digits and "-")`,
    );
  }
  if (opts.isReserved(name)) {
    return skip(filePath, `"${name}" is already taken by a built-in agent or a slash command`);
  }

  // Grant precedence: an explicit `tools` list wins, else `readonly: true` is the read-only set,
  // else everything — the same grant the built-in `code` agent holds.
  const entries = readToolEntries(fields.tools);
  let toolNames: readonly ToolName[];
  if (entries === undefined) {
    toolNames =
      fields.readonly === true
        ? READ_ONLY_TOOL_NAMES
        : (Object.keys(toolDefinitions) as ToolName[]);
  } else {
    const granted: ToolName[] = [];
    for (const entry of entries) {
      const resolved = TOOL_ALIASES[entry.toLowerCase()];
      if (resolved === undefined) {
        warnings.push(
          `agent file ${filePath}: "${entry}" is not a tool seri has, so it was dropped`,
        );
        continue;
      }
      if (!granted.includes(resolved)) granted.push(resolved);
    }
    // Falling back to the full toolset here would hand bash to an author who plainly meant to
    // restrict it. A skipped agent is visible; an over-granted one is not.
    if (granted.length === 0) {
      return skip(filePath, "its `tools:` list names nothing seri recognises");
    }
    toolNames = granted;
  }

  const rawModel = readString(fields.model);
  const params = rawModel === undefined ? null : MODEL_PARAMS.exec(rawModel);
  const modelId = (params === null ? rawModel : params[1]?.trim()) ?? "";
  const bracketEffort = (params?.[2] ?? "")
    .split(",")
    .map((param) => param.split("="))
    .find(([key]) => key?.trim() === "effort")?.[1]
    ?.trim();
  const effort = readString(bracketEffort) ?? readString(fields.effort);

  // Complete-or-absent, never a half pin: an id no configured provider serves inherits the session
  // route with a warning, exactly as an unusable SERI_ROLE_* pair does.
  let pair: { model: string; provider: ModelProvider } | undefined;
  if (modelId.length > 0 && modelId.toLowerCase() !== "inherit") {
    pair = opts.resolveModel(modelId);
    if (pair === undefined) {
      warnings.push(
        `agent file ${filePath}: no configured provider serves "${modelId}", so it inherits the session model`,
      );
    }
  }

  const description = readString(fields.description);
  if (description === undefined) {
    // Loaded, not skipped: the parent model has nothing to delegate on, so in practice only an
    // explicit /name reaches it — describeAgent (registry.ts) is what leaves it out of the
    // dispatch tool's description.
    warnings.push(
      `agent file ${filePath}: no description, so the model is never told this agent exists`,
    );
  }

  const body = opts.text.slice(fence[0].length).trim();
  return {
    kind: "spec",
    spec: {
      name,
      description: description ?? "",
      toolNames,
      addendum: composeAddendum({
        name,
        job: body.length > 0 ? body : (description ?? ""),
        toolNames,
      }),
      request:
        pair !== undefined
          ? { model: pair.model, provider: pair.provider, effort }
          : effort === undefined
            ? undefined
            : { effort },
      source: opts.source,
      filePath,
    },
    warnings,
  };
}
