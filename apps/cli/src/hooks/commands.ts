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





export function hooksCommandAccepts(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "list" || sub === "show" || sub === "trust" || sub === "untrust")
    return rest.length === 0;
  return false;
}

const UNTRUSTED_LINE =
  "Not reviewed. Nothing in it runs. /hooks show to read the scripts, /hooks trust to turn them on.";



const CHANGED_FILES_CAP = 5;

function changedFilesLine(files: readonly string[]): string {
  const shown = files.slice(0, CHANGED_FILES_CAP);
  const rest = files.length - shown.length;
  return (
    `Changed: ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}. ` +
    "Nothing runs until it is reviewed again."
  );
}




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





    lines.push("Trusted.");
    const rows = wiringRows(hooksLoad.registry, "project");
    lines.push(...(rows.length > 0 ? rows : ["No hooks configured."]));
    return lines;
  }

  lines.push(verdict.kind === "changed" ? changedFilesLine(verdict.files) : UNTRUSTED_LINE);
  const fileCount = digestHooksDir(projectDir).size;
  lines.push(`${fileCount} file${fileCount === 1 ? "" : "s"} in this directory.`);
  return lines;
}




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
