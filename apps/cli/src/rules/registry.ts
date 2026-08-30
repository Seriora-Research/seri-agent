import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { RULES_DIRNAME } from "../config/paths";
import { messageOf } from "../errors";
import { extensionScopes } from "../extensions/discovery";
import { parseRuleFile, type RuleSpec } from "./ruleFile";

export type { RuleSpec, RuleTrigger } from "./ruleFile";

/** Insertion order is precedence order: global, then project. A later `set` shadows an earlier one,
 *  so "project beats global" is structural rather than a conditional. Keyed by the filename without
 *  `.mdc`, which is the only name a rule has. */
export type RuleRegistry = ReadonlyMap<string, RuleSpec>;

function ruleFilesIn(dir: string, onWarning: (message: string) => void): readonly string[] {
  try {
    return readdirSync(dir)
      .filter((entry) => entry.toLowerCase().endsWith(".mdc"))
      .sort()
      .map((entry) => join(dir, entry));
  } catch (err) {
    onWarning(`could not read the rules directory ${dir}: ${messageOf(err)}`);
    return [];
  }
}

/**
 * The profile root's `rules/`, then the project's `.seri/rules/`, into one Map in that order.
 * Every failure below is a warning, never a throw: session start must not fail over a rule file.
 */
export function loadRuleRegistry(opts: {
  worktree: string;
  configDir: string;
  onWarning: (message: string) => void;
}): RuleRegistry {
  const rules = new Map<string, RuleSpec>();
  const scopes = extensionScopes({
    worktree: opts.worktree,
    configDir: opts.configDir,
    dirname: RULES_DIRNAME,
  });

  for (const scope of scopes) {
    if (!existsSync(scope.dir)) continue;
    const loaded: string[] = [];
    for (const filePath of ruleFilesIn(scope.dir, opts.onWarning)) {
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (err) {
        opts.onWarning(`could not read the rule file ${filePath}: ${messageOf(err)}`);
        continue;
      }
      const outcome = parseRuleFile({ filePath, text, source: scope.source });
      if (outcome.kind === "skipped") {
        opts.onWarning(outcome.warning);
        continue;
      }
      for (const warning of outcome.warnings) opts.onWarning(warning);
      rules.set(outcome.spec.name, outcome.spec);
      loaded.push(outcome.spec.name);
    }
    if (loaded.length > 0) opts.onWarning(`rules from ${scope.dir}: ${loaded.join(", ")}`);
  }
  return rules;
}

/**
 * The context tier's always-on rules, in load order. Empty string when there are none, so joinTiers'
 * own filter(Boolean) drops it and a project with no rules renders byte-identically to one from
 * before this existed.
 *
 * Each rule is fenced with its own filename. A rule is a standing instruction the agent is expected
 * to follow, and without the filename a reader of a misbehaving session cannot tell which file said
 * what.
 */
export function renderRulesTier(rules: readonly RuleSpec[]): string {
  const always = rules.filter((rule) => rule.trigger === "always");
  if (always.length === 0) return "";
  return [
    "# Project rules",
    "Standing rules for this project, from its own rule files. Follow them for the whole session.",
    ...always.flatMap((rule) => ["", `## ${rule.name}`, rule.body]),
  ].join("\n");
}

// Forward slashes on every platform. node:path produces "\" on Windows, and a pattern written
// `src/**` in a file a Linux user also opens must match the same file on both — this repo ships on
// all three OSes and CI runs all three.
function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * The worktree-relative, forward-slashed path a rule's globs are matched against, or undefined when
 * the path is outside the worktree entirely. `relative` returning a `..` prefix, or something still
 * absolute, is what "outside" looks like; neither can match a project rule and both are dropped
 * rather than matched loosely.
 */
export function worktreeRelativePath(
  worktree: string,
  cwd: string,
  rawPath: string,
): string | undefined {
  // Resolved against the session's cwd exactly as the tool itself resolves it, so a rule fires on
  // the same file the tool actually touched rather than on a string that merely looks alike.
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(resolve(worktree), absolute);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

/** True when any of the rule's patterns matches. `Bun.Glob` handles `**`, braces and ranges, and is
 *  a runtime builtin rather than a dependency — the `glob` TOOL shells to vendored ripgrep, which is
 *  the wrong shape for matching one path per tool call. */
export function ruleMatchesPath(rule: RuleSpec, relativePath: string): boolean {
  return rule.globs.some((pattern) => new Bun.Glob(pattern).match(relativePath));
}
