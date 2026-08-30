import {
  type RuleRegistry,
  type RuleSpec,
  ruleMatchesPath,
  worktreeRelativePath,
} from "./registry";

/**
 * Which glob-scoped rules have already fired this session. Session-scoped, rebuilt on `/clear` the
 * same way the archivist's own state is, and passed in rather than kept module-level so two
 * sessions in one process (every `bun test` run, and a future daemon) cannot bleed into each other.
 */
export type RulesState = { readonly fired: Set<string> };

export function createRulesState(): RulesState {
  return { fired: new Set() };
}

// The marker the injected message is wrapped in. Plain text, no model-specific grammar, and stated
// as coming from the harness rather than the user — without that line the model reads a rule as
// something the person just typed, and may answer it instead of following it.
export const RULE_MARKER_OPEN = "<project-rules";

// Only these two tools carry an unambiguous single file path. `edit` takes content and no path at
// all, `grep`/`glob` take a directory to search, and `bash`/`powershell` take free text that may
// name any number of files or none. Matching on `read_file` is what puts a rule in context BEFORE
// the model composes an edit, which is the order the system prompt's own read/edit/write sequence
// teaches.
const PATH_TOOLS = new Set(["read_file", "write_file"]);

function pathOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Builds the `onToolPhaseEnd` callback runLoop takes, or undefined when this session has no
 * glob-scoped rule at all — so a project without one pays nothing per tool round, not even a
 * function call.
 *
 * Returns the text to append, or undefined when nothing new matched. A rule fires at most once per
 * session: its text is already in the conversation history afterwards, which is append-only, so
 * re-injecting on turn 40 would restate what the model can still read from turn 1.
 */
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
      // Marked at the moment it is selected, not after the message is built, so two rules matching
      // in one round cannot both claim to be the first and neither can fire twice.
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
