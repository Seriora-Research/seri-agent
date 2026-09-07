import { basename, dirname } from "node:path";
import { parse } from "yaml";
import { messageOf } from "../errors";
import type { ExtensionSource } from "../extensions/discovery";






export type SkillAuthor = "human" | "archivist";


export type SkillSpec = {
  readonly name: string;
  readonly description: string;

  readonly argumentHint: string | undefined;

  readonly modelInvocable: boolean;
  readonly author: SkillAuthor;
  readonly filePath: string;
  readonly source: ExtensionSource;
};

export type SkillFileOutcome =
  | { readonly kind: "spec"; readonly spec: SkillSpec; readonly warnings: readonly string[] }
  | { readonly kind: "skipped"; readonly warning: string };



const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const NAME_SHAPE = /^[a-z0-9][a-z0-9-]*$/;




const MAX_DESCRIPTION_LENGTH = 500;









const IGNORED_KEYS = ["allowed-tools", "model", "context"] as const;

function skip(filePath: string, reason: string): SkillFileOutcome {
  return { kind: "skipped", warning: `skill file ${filePath} was skipped: ${reason}` };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}




function hintFromArguments(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((entry): entry is string => typeof entry === "string");
  return names.length === 0 ? undefined : names.map((name) => `<${name}>`).join(" ");
}

export function parseSkillFile(opts: {

  filePath: string;
  text: string;
  source: ExtensionSource;

  isReserved: (name: string) => boolean;
}): SkillFileOutcome {
  const { filePath } = opts;


  // UTF-8 BOM: Notepad and PowerShell redirection write one ahead of the opening fence.
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


export function skillBodyOf(text: string): string {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const fence = FRONTMATTER.exec(stripped);
  return (fence === null ? stripped : stripped.slice(fence[0].length)).trim();
}
