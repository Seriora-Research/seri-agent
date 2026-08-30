import { basename } from "node:path";
import { parse } from "yaml";
import { messageOf } from "../errors";
import type { ExtensionSource } from "../extensions/discovery";

/**
 * When a rule's body reaches the model. The three are mutually exclusive and resolved once, at
 * parse time, so nothing downstream re-derives the answer from the raw frontmatter and risks
 * disagreeing with this.
 *
 * - `always`  — `alwaysApply: true`. Loads into the frozen context tier, next to `AGENTS.md`.
 * - `globs`   — loads when the session touches a file the patterns match.
 * - `inert`   — a `description` and nothing else. Cursor calls this "agent requested" and lets the
 *               model pull the body. That is the same load semantic skills already ship, so it is
 *               deferred rather than given a second implementation here; such a rule loads nothing
 *               and says so once, naming the file.
 */
export type RuleTrigger = "always" | "globs" | "inert";

export type RuleSpec = {
  readonly name: string;
  readonly description: string;
  readonly trigger: RuleTrigger;
  /** Empty unless `trigger` is "globs". Already split; brace groups kept intact. */
  readonly globs: readonly string[];
  /** The text below the frontmatter. Held in memory, unlike a skill's: a rule has no on-demand
   *  load — an `always` rule is in the prompt from session start, and a `globs` rule has to be
   *  ready to inject the instant a matching path is touched, mid-turn, with no room for a read. */
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

/**
 * Splits a `globs:` scalar on commas WITHOUT breaking a brace group. Both shapes are live in the
 * wild, one directory over in this repo's own `.cursor/rules/`:
 *
 *     globs: "**\/*.{ts,tsx,js,jsx,py,go,rs,java}"   one pattern, commas inside braces
 *     globs: .cursor/skills/**,.cursor/loop-models.json   two patterns, commas between them
 *
 * A naive `split(",")` turns the first into four broken patterns that match nothing, which fails
 * silently — the rule simply never fires. Depth-tracking is what tells the two apart.
 */
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

// A YAML list, or a comma-separated scalar. `null` (a bare `globs:` line) reads as "present and
// says nothing", which is the same as absent for this field: there is no grant being given up, so
// unlike an agent file's `tools:` there is nothing to fail closed about.
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
  // `alwaysApply` wins over `globs` when a file sets both, which `code-quality.mdc` in this repo
  // does. That is Cursor's own precedence and it is the only coherent reading: a rule that is
  // always in the prompt has nothing left for a per-touch trigger to add, and injecting it again on
  // a match would put the same text in the session twice.
  const trigger: RuleTrigger =
    fields.alwaysApply === true ? "always" : globs.length > 0 ? "globs" : "inert";

  if (trigger === "inert") {
    // Loaded, not skipped, and reported: the file is well-formed and its author expects it to do
    // something. Saying nothing would leave them reading a rule that is silently inert.
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
