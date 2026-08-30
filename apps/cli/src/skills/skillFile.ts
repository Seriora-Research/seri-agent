import { basename, dirname } from "node:path";
import { parse } from "yaml";
import { messageOf } from "../errors";
import type { ExtensionSource } from "../extensions/discovery";

// Who wrote the file. `archivist` is set by the frontmatter key the staged-write path stamps
// (skills/pending.ts) and by nothing else — a human is free to type it, which is a labelling
// mistake and not a security boundary: nothing is granted or withheld on the strength of this
// field. It exists so a reader of `/skills list` can tell at a glance which of their skills seri
// proposed and they approved, rather than having to open every file to find out.
export type SkillAuthor = "human" | "archivist";

/**
 * One loadable skill. Produced ONLY by parseSkillFile, and deliberately WITHOUT a `body` field —
 * that absence is the progressive-disclosure contract made structural rather than promised. A
 * registry of twenty skills cannot leak twenty bodies into the session prompt, because the loaded
 * shape has nowhere to put one; the body is read from `filePath` at the moment the skill actually
 * fires (readSkillBody, skills/registry.ts) and never before.
 */
export type SkillSpec = {
  readonly name: string;
  readonly description: string;
  /** Usage text for `/name`, from `argument-hint` or derived from `arguments`. */
  readonly argumentHint: string | undefined;
  /** False when the file sets `disable-model-invocation: true`. Such a skill is left out of the
   *  prompt's skill listing AND refused by the skill tool, so `/name` is its only entry point. */
  readonly modelInvocable: boolean;
  readonly author: SkillAuthor;
  readonly filePath: string;
  readonly source: ExtensionSource;
};

export type SkillFileOutcome =
  | { readonly kind: "spec"; readonly spec: SkillSpec; readonly warnings: readonly string[] }
  | { readonly kind: "skipped"; readonly warning: string };

// Same tolerant fence agentFile.ts uses, and for the same reason: these files are edited on
// Windows too, and a directory holding a stray README must not load it as a skill.
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const NAME_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

// The listing this description rides in sits in the frozen context tier, which is resent whole on
// every turn of the session — an essay in this field is a per-turn tax, not a one-off cost of the
// file. Same cap agentFile.ts applies to the same kind of field for the same reason.
const MAX_DESCRIPTION_LENGTH = 500;

// Read and acted on: name, description, argument-hint, arguments, disable-model-invocation, author.
// Present in the Cursor format and deliberately NOT acted on: `allowed-tools`, `model`, `context`.
// A skill runs in the parent's own context, on the parent's model, with the parent's tools — seri
// has no mid-turn toolset swap and no per-skill route, so honouring either key would be inventing a
// mechanism this stage does not ship. Silence would be the wrong answer: an author who wrote
// `allowed-tools: Read` believes the skill is restricted when it is not, which is a safety-shaped
// misreading rather than a cosmetic one. So the keys are tolerated, ignored, and warned about once,
// naming the file.
const IGNORED_KEYS = ["allowed-tools", "model", "context"] as const;

function skip(filePath: string, reason: string): SkillFileOutcome {
  return { kind: "skipped", warning: `skill file ${filePath} was skipped: ${reason}` };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

// `arguments: [mode, prompt, models]` is an autocomplete hint in the format this borrows from, not
// a binding: substitution is positional either way (substituteSkillArgs, skills/registry.ts). So
// the names are worth exactly one thing, a usage line, and that is all this does with them.
function hintFromArguments(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((entry): entry is string => typeof entry === "string");
  return names.length === 0 ? undefined : names.map((name) => `<${name}>`).join(" ");
}

export function parseSkillFile(opts: {
  /** The `SKILL.md` itself. The skill's default name is its PARENT directory, not this filename. */
  filePath: string;
  text: string;
  source: ExtensionSource;
  /** Rejects a name colliding with a slash command or a built-in agent. */
  isReserved: (name: string) => boolean;
}): SkillFileOutcome {
  const { filePath } = opts;
  // A UTF-8 BOM is what Notepad and PowerShell redirection both write, and it lands ahead of the
  // opening fence — where it would otherwise be the difference between a skill and a stray note.
  const text = opts.text.charCodeAt(0) === 0xfeff ? opts.text.slice(1) : opts.text;
  const fence = FRONTMATTER.exec(text);
  if (fence === null) return skip(filePath, "it has no YAML frontmatter block");

  let front: unknown;
  try {
    front = parse(fence[1] ?? "");
  } catch (err) {
    return skip(filePath, `its frontmatter is not valid YAML (${messageOf(err)})`);
  }
  if (typeof front !== "object" || front === null || Array.isArray(front)) {
    return skip(filePath, "its frontmatter is not a mapping of keys to values");
  }
  const fields = front as Record<string, unknown>;
  const warnings: string[] = [];

  // The directory names the skill, which is what makes `.seri/skills/<name>/SKILL.md` self-
  // describing — every file in the tree is called SKILL.md, so the filename could only ever have
  // produced one name for all of them.
  const name = (readString(fields.name) ?? basename(dirname(filePath))).toLowerCase();
  if (!NAME_SHAPE.test(name)) {
    return skip(
      filePath,
      `"${name}" is not a usable skill name (lowercase letters, digits and "-")`,
    );
  }
  if (opts.isReserved(name)) {
    return skip(filePath, `"${name}" is already taken by a slash command or a built-in agent`);
  }

  const present = IGNORED_KEYS.filter((key) => fields[key] !== undefined);
  if (present.length > 0) {
    warnings.push(
      `skill file ${filePath}: seri ignores ${present.map((key) => `"${key}"`).join(" and ")} on ` +
        `skills — a skill runs in the parent's context, on the parent's model, with the parent's tools`,
    );
  }

  let description = readString(fields.description);
  if (description !== undefined && description.length > MAX_DESCRIPTION_LENGTH) {
    warnings.push(
      `skill file ${filePath}: its description is longer than ${MAX_DESCRIPTION_LENGTH} characters, so it was truncated`,
    );
    description = description.slice(0, MAX_DESCRIPTION_LENGTH);
  }
  const modelInvocable = fields["disable-model-invocation"] !== true;
  if (description === undefined && modelInvocable) {
    // Loaded, not skipped: `/name` still reaches it. Only the model-facing half is lost, which is
    // exactly what renderSkillsTier leaves out for a skill with nothing to select on.
    warnings.push(
      `skill file ${filePath}: no description, so the model is never told this skill exists`,
    );
  }

  return {
    kind: "spec",
    spec: {
      name,
      description: description ?? "",
      argumentHint: readString(fields["argument-hint"]) ?? hintFromArguments(fields.arguments),
      modelInvocable,
      author: readString(fields.author) === "archivist" ? "archivist" : "human",
      filePath,
      source: opts.source,
    },
    warnings,
  };
}

/** The body is everything after the frontmatter fence. Shared by readSkillBody and by the staged
 *  write's own diff, so "what the model is handed" and "what the human previewed" cannot diverge. */
export function skillBodyOf(text: string): string {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const fence = FRONTMATTER.exec(stripped);
  return (fence === null ? stripped : stripped.slice(fence[0].length)).trim();
}
