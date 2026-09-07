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

  readonly untrusted?: {
    readonly dir: string;
    readonly verdict: TrustVerdict;
    readonly scriptCount: number;
  };
};






function scriptCountIn(dir: string): number {
  return [...digestHooksDir(dir).keys()].filter((name) => name !== HOOKS_FILENAME).length;
}


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
