import {
  type RuleRegistry,
  type RuleSpec,
  ruleMatchesPath,
  worktreeRelativePath,
} from "./registry";


export type RulesState = { readonly fired: Set<string> };

export function createRulesState(): RulesState {
  return { fired: new Set() };
}




export const RULE_MARKER_OPEN = "<project-rules";






const PATH_TOOLS = new Set(["read_file", "write_file"]);

function pathOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}


export function createRuleInjector(opts: {
  rules: RuleRegistry;
  state: RulesState;
  worktree: string;
  cwd: string;
}):
  | ((executed: readonly { toolName: string; input: unknown }[]) => string | undefined)
  | undefined {
  const scoped = [...opts.rules.values()].filter((rule) => rule.trigger === "globs");
  if (scoped.length === 0) return undefined;

  return (executed) => {
    const paths: string[] = [];
    for (const call of executed) {
      if (!PATH_TOOLS.has(call.toolName)) continue;
      const raw = pathOf(call.input);
      if (raw === undefined) continue;
      const rel = worktreeRelativePath(opts.worktree, opts.cwd, raw);
      if (rel !== undefined) paths.push(rel);
    }
    if (paths.length === 0) return undefined;

    const newlyFired: { rule: RuleSpec; path: string }[] = [];
    for (const rule of scoped) {
      if (opts.state.fired.has(rule.filePath)) continue;
      const hit = paths.find((path) => ruleMatchesPath(rule, path));
      if (hit === undefined) continue;


      opts.state.fired.add(rule.filePath);
      newlyFired.push({ rule, path: hit });
    }
    if (newlyFired.length === 0) return undefined;

    const matched = [...new Set(newlyFired.map((entry) => entry.path))].join(", ");
    return [
      `${RULE_MARKER_OPEN} matched="${matched}">`,
      "Automated notice from the harness, not from the user. These project rules apply to files",
      "this session is touching. Follow them for the rest of the session.",
      ...newlyFired.flatMap(({ rule }) => ["", `## ${rule.name}`, rule.body]),
      "</project-rules>",
    ].join("\n");
  };
}
