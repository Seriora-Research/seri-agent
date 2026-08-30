import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS_DIRNAME } from "../config/paths";
import { messageOf } from "../errors";
import { extensionScopes } from "../extensions/discovery";
import { parseHooksFile } from "./hooksFile";
import { checkTrust, digestHooksDir, type TrustVerdict } from "./trust";
import { HOOKS_FILENAME, type HookEvent, type HookRegistry, type HookSpec } from "./types";

export type HooksLoad = {
  readonly registry: HookRegistry;
  /** Set when a project hooks directory was found but is not running. */
  readonly untrusted?: {
    readonly dir: string;
    readonly verdict: TrustVerdict;
    readonly scriptCount: number;
  };
};

// Counted off the directory listing rather than off the manifest, because the whole point of the
// untrusted branch is that nothing in that directory has been read yet — parsing hooks.yaml to
// count its entries would be reading the attacker's file to describe the attacker's file. Every
// file except the manifest is a candidate for execution (a script, or a helper a script sources),
// which is the same rule digestHooksDir hashes by.
function scriptCountIn(dir: string): number {
  return [...digestHooksDir(dir).keys()].filter((name) => name !== HOOKS_FILENAME).length;
}

/**
 * The profile root's `hooks/`, then the project's `.seri/hooks/`, into one registry keyed by event.
 * Every failure below is a warning, never a throw: session start must not fail over a hooks file.
 */
export function loadHookRegistry(opts: {
  worktree: string;
  configDir: string;
  onWarning: (message: string) => void;
}): HooksLoad {
  const registry = new Map<HookEvent, HookSpec[]>();
  let untrusted: HooksLoad["untrusted"];
  const scopes = extensionScopes({
    worktree: opts.worktree,
    configDir: opts.configDir,
    dirname: HOOKS_DIRNAME,
  });

  for (const scope of scopes) {
    if (!existsSync(scope.dir)) continue;

    // The user scope is not checked, on the same grounds getHooksDir states: nothing reaches a
    // profile root by cloning a repository. The project scope runs only against a recorded grant,
    // and when it has none nothing from that directory is parsed at all — not the manifest, not a
    // spec, not a warning per hook. One notice, raised by the caller from the field below, because
    // a per-hook warning would describe an untrusted file's contents as if seri had adopted them.
    if (scope.source === "project") {
      const verdict = checkTrust({
        configDir: opts.configDir,
        dir: scope.dir,
        onWarning: opts.onWarning,
      });
      if (verdict.kind !== "trusted") {
        untrusted = { dir: scope.dir, verdict, scriptCount: scriptCountIn(scope.dir) };
        continue;
      }
    }

    const filePath = join(scope.dir, HOOKS_FILENAME);
    // A hooks directory holding only scripts, or nothing yet, is a project mid-setup rather than a
    // mistake — nothing to warn about.
    if (!existsSync(filePath)) continue;
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      opts.onWarning(`could not read ${filePath}: ${messageOf(err)}`);
      continue;
    }

    const { specs, warnings } = parseHooksFile({
      text,
      filePath,
      dir: scope.dir,
      source: scope.source,
    });
    for (const warning of warnings) opts.onWarning(warning);

    // Both scopes' hooks RUN, appended in scope order. This is the one extension where "project
    // beats global" — the later-`set`-wins rule skills, rules and MCP servers all share — is the
    // wrong reflex: those are keyed by a name, so two entries under one name are a conflict
    // somebody has to resolve. A hook has no such key. A global audit hook and a project's
    // formatter are two things the user asked for, not two answers to one question, and dropping
    // either because the other exists would silently disarm a hook that was never in conflict.
    for (const spec of specs) {
      const list = registry.get(spec.event);
      if (list === undefined) registry.set(spec.event, [spec]);
      else list.push(spec);
    }
    if (specs.length > 0) {
      opts.onWarning(`hooks from ${scope.dir}: ${specs.map((s) => s.script).join(", ")}`);
    }
  }

  return untrusted === undefined ? { registry } : { registry, untrusted };
}
