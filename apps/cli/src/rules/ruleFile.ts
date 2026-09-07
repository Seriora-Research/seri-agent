import { basename } from "node:path";
import { parse } from "yaml";
import { messageOf } from "../errors";
import type { ExtensionSource } from "../extensions/discovery";


export type RuleTrigger = "always" | "globs" | "inert";

export type RuleSpec = {
  readonly name: string;
  readonly description: string;
  readonly trigger: RuleTrigger;

  readonly globs: readonly string[];

  readonly body: string;
  readonly filePath: string;
  readonly source: ExtensionSource;
};

export type RuleFileOutcome =
  | { readonly kind: "spec"; readonly spec: RuleSpec; readonly warnings: readonly string[] }
  | { readonly kind: "skipped"; readonly warning: string };

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MDC_EXTENSION = /\.mdc$/i;

function skip(filePath: string, reason: string): RuleFileOutcome {
  return { kind: "skipped", warning: `rule file ${filePath} was skipped: ${reason}` };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}


function splitPatterns(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
}




function readGlobs(value: unknown): string[] {
  if (typeof value === "string") return splitPatterns(value);
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap(splitPatterns);
  }
  return [];
}

export function parseRuleFile(opts: {
  filePath: string;
  text: string;
  source: ExtensionSource;
}): RuleFileOutcome {
  const { filePath } = opts;
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

  const body = text.slice(fence[0].length).trim();
  if (body.length === 0) return skip(filePath, "it has no body below its frontmatter");

  const globs = readGlobs(fields.globs);




  const trigger: RuleTrigger =
    fields.alwaysApply === true ? "always" : globs.length > 0 ? "globs" : "inert";

  if (trigger === "inert") {


    warnings.push(
      `rule file ${filePath}: no "alwaysApply" and no "globs", so nothing loads it — seri does not ` +
        `yet support a rule the model pulls in by description`,
    );
  }

  return {
    kind: "spec",
    spec: {
      name: basename(filePath).replace(MDC_EXTENSION, ""),
      description: readString(fields.description) ?? "",
      trigger,
      globs: trigger === "globs" ? globs : [],
      body,
      filePath,
      source: opts.source,
    },
    warnings,
  };
}
