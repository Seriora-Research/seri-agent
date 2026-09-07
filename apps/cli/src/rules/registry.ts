import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { RULES_DIRNAME } from "../config/paths";
import { messageOf } from "../errors";
import { extensionScopes } from "../extensions/discovery";
import { parseRuleFile, type RuleSpec } from "./ruleFile";

export type { RuleSpec, RuleTrigger } from "./ruleFile";


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


export function renderRulesTier(rules: readonly RuleSpec[]): string {
  const always = rules.filter((rule) => rule.trigger === "always");
  if (always.length === 0) return "";
  return [
    "# Project rules",
    "Standing rules for this project, from its own rule files. Follow them for the whole session.",
    ...always.flatMap((rule) => ["", `## ${rule.name}`, rule.body]),
  ].join("\n");
}




function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}


export function worktreeRelativePath(
  worktree: string,
  cwd: string,
  rawPath: string,
): string | undefined {


  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(resolve(worktree), absolute);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return toPosix(rel);
}


export function ruleMatchesPath(rule: RuleSpec, relativePath: string): boolean {
  return rule.globs.some((pattern) => new Bun.Glob(pattern).match(relativePath));
}
