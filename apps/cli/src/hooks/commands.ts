import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getHooksDir, HOOKS_DIRNAME } from "../config/paths";
import { messageOf } from "../errors";
import { type ExtensionSource, findProjectExtensionDir } from "../extensions/discovery";
import { loadHookRegistry } from "./registry";
import { checkTrust, digestHooksDir, trustHooksDir, untrustHooksDir } from "./trust";
import { HOOK_EVENTS, type HookRegistry, type HookSpec } from "./types";

export type HooksCommandDeps = {
  readonly worktree: string;
  readonly configDir: string;
};

// The argv gate cli.ts runs before dispatch, kept here so it is testable against the exact strings
// a user types — the same split skillsCommandAccepts and mcpCommandAccepts use. show/trust/untrust
// take no argument: there is exactly one project hooks directory per worktree, so there is nothing
// for an argument to select.
export function hooksCommandAccepts(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "list" || sub === "show" || sub === "trust" || sub === "untrust")
    return rest.length === 0;
  return false;
}

const UNTRUSTED_LINE =
  "Not reviewed. Nothing in it runs. /hooks show to read the scripts, /hooks trust to turn them on.";

// A few names read naturally in a sentence; past that the line becomes the list of files it was
// trying to avoid being. Matches toolActivity.ts's own "…and N more" cap for the identical reason.
const CHANGED_FILES_CAP = 5;

function changedFilesLine(files: readonly string[]): string {
  const shown = files.slice(0, CHANGED_FILES_CAP);
  const rest = files.length - shown.length;
  return (
    `Changed: ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}. ` +
    "Nothing runs until it is reviewed again."
  );
}

// hooksFile.ts always compiles a matcher as `^(?:<what the author wrote>)$` (anchored so "edit"
// matches the tool and not the tail of "credit_check"). Undoing that wrapper for display is what
// lets this line show the author their own text back rather than a regex they didn't write.
function matcherLabel(spec: HookSpec): string {
  if (spec.matcher === undefined) return "(every tool)";
  const wrapped = spec.matcher.source.match(/^\^\(\?:([\s\S]*)\)\$$/);
  return wrapped ? wrapped[1] : spec.matcher.source;
}

function wiringRows(registry: HookRegistry, source: ExtensionSource): string[] {
  const rows: string[] = [];
  for (const event of HOOK_EVENTS) {
    for (const spec of registry.get(event) ?? []) {
      if (spec.source === source) rows.push(`${event}  ${matcherLabel(spec)}  ${spec.script}`);
    }
  }
  return rows;
}

// The trust verdict is recomputed here rather than read off `HooksLoad`, even though
// loadHookRegistry already ran checkTrust once and its `untrusted` field carries the answer. The
// duplicated digest walk buys the only thing the cheaper reading loses: checkTrust reports a
// hooks-trust.yaml it could not parse through `onWarning`, and loadHookRegistry's own callback also
// carries its informational per-scope summary, so the two cannot be told apart at that seam. A
// store seri refuses to read is precisely what the user typing /hooks needs to be told, and paying
// one walk on an explicit command to say so is the right trade.
function listLines(deps: HooksCommandDeps): string[] {
  const storeWarnings: string[] = [];
  const hooksLoad = loadHookRegistry({
    worktree: deps.worktree,
    configDir: deps.configDir,
    onWarning: () => {},
  });
  const profileDir = getHooksDir(deps.configDir);
  const projectDir = findProjectExtensionDir(deps.worktree, HOOKS_DIRNAME);

  const lines: string[] = [`Profile hooks — ${profileDir}`];
  if (!existsSync(profileDir)) {
    lines.push("No profile hooks directory.");
  } else {
    const rows = wiringRows(hooksLoad.registry, "user");
    lines.push(...(rows.length > 0 ? rows : ["No hooks configured."]));
  }

  lines.push("");
  if (projectDir === undefined) {
    lines.push("Project hooks — none found.");
    return lines;
  }

  lines.push(`Project hooks — ${projectDir}`);
  const verdict = checkTrust({
    configDir: deps.configDir,
    dir: projectDir,
    onWarning: (message) => storeWarnings.push(message),
  });
  lines.push(...storeWarnings);
  if (verdict.kind === "trusted") {
    lines.push("Trusted. Hooks below are live.");
    const rows = wiringRows(hooksLoad.registry, "project");
    lines.push(...(rows.length > 0 ? rows : ["No hooks configured."]));
    return lines;
  }

  lines.push(verdict.kind === "changed" ? changedFilesLine(verdict.files) : UNTRUSTED_LINE);
  const fileCount = digestHooksDir(projectDir).size;
  lines.push(`${fileCount} file${fileCount === 1 ? "" : "s"} in this directory.`);
  return lines;
}

// Every file digestHooksDir would hash, read and printed in full — that key set is the grant
// itself, so iterating anything else (a fresh directory walk, or hooks.yaml's own script list)
// could show the user a different file list than the one /hooks trust is about to sign off on.
function showLines(deps: HooksCommandDeps): string[] {
  const projectDir = findProjectExtensionDir(deps.worktree, HOOKS_DIRNAME);
  if (projectDir === undefined) return ["No project hooks directory."];

  const files = [...digestHooksDir(projectDir).keys()].sort();
  const lines: string[] = [];
  for (const key of files) {
    lines.push(`── ${key} ──`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(projectDir, ...key.split("/")));
    } catch (err) {
      lines.push(`Could not read ${key}: ${messageOf(err)}`);
      continue;
    }
    try {
      // `fatal: true` is the point: a silent replace-invalid-bytes decode would show corrupted
      // text as though it were the script's real content instead of admitting it isn't text.
      lines.push(...new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/));
    } catch {
      lines.push(`${key} is not decodable as text.`);
    }
  }
  lines.push(`${files.length} file${files.length === 1 ? "" : "s"}. /hooks trust turns them on.`);
  return lines;
}

function trustResult(deps: HooksCommandDeps): string[] {
  const projectDir = findProjectExtensionDir(deps.worktree, HOOKS_DIRNAME);
  if (projectDir === undefined) return ["No project hooks directory to trust."];

  const warnings: string[] = [];
  trustHooksDir(deps.configDir, projectDir, (message) => warnings.push(message));
  // A warning means the write never landed — reporting "trusted" over it would tell the user a
  // grant exists when the store still says otherwise.
  if (warnings.length > 0) return warnings;

  const count = digestHooksDir(projectDir).size;
  return [
    `Trusted ${projectDir} (${count} file${count === 1 ? "" : "s"}). ` +
      "It loads in the next session, or after /clear.",
  ];
}

function untrustResult(deps: HooksCommandDeps): string[] {
  const projectDir = findProjectExtensionDir(deps.worktree, HOOKS_DIRNAME);
  if (projectDir === undefined) return ["No project hooks directory to untrust."];

  const removed = untrustHooksDir(deps.configDir, projectDir);
  return removed
    ? [`Untrusted ${projectDir}. Nothing in it runs until it is reviewed again.`]
    : [`${projectDir} was not trusted.`];
}

export function decideHooksCommand(args: string[], deps: HooksCommandDeps): { lines: string[] } {
  const [sub] = args;
  if (sub === "show") return { lines: showLines(deps) };
  if (sub === "trust") return { lines: trustResult(deps) };
  if (sub === "untrust") return { lines: untrustResult(deps) };
  return { lines: listLines(deps) };
}
