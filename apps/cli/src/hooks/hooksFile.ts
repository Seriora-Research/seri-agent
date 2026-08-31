import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { messageOf } from "../errors";
import type { ExtensionSource } from "../extensions/discovery";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  type HookEvent,
  type HookSpec,
  isHookEvent,
} from "./types";

export type HooksFileOutcome = {
  readonly specs: readonly HookSpec[];
  readonly warnings: readonly string[];
};

// The path-escape guard: a manifest name is the only thing that reaches the OS-specific file on
// disk, so a "/", "\" or "." anywhere (which also catches ".." on its own) is rejected rather than
// resolved — the pairing lookup below must never be able to step outside `dir`.
//
// ":" is in the set for a win32-only reason worth naming, because it is not a separator and looks
// safe. `dir\a:b.ps1` is an NTFS alternate data stream hanging off `dir\a`, and readdirSync does
// not list streams — so it is a file the trust digest (hooks/trust.ts) cannot see and therefore
// cannot pin, while spawn would still run it. Rejecting the name is cheaper than teaching the
// digest about streams, and nothing legitimate is lost: git cannot check one in.
export const SCRIPT_NAME_SHAPE = /^[^./\\:]+$/;

function parseOneHookEntry(opts: {
  event: HookEvent;
  index: number;
  raw: unknown;
  filePath: string;
  dir: string;
  source: ExtensionSource;
  platform: NodeJS.Platform;
  scriptExists: (path: string) => boolean;
}): { spec: HookSpec | undefined; warning: string | undefined } {
  const { event, index, raw, filePath } = opts;
  const label = `entry ${index + 1} under "${event}"`;
  const skip = (reason: string) => ({
    spec: undefined,
    warning: `${filePath}: ${label} was skipped: ${reason}`,
  });

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return skip("it is not a mapping of keys to values");
  }
  const fields = raw as Record<string, unknown>;

  const rawScript = fields.script;
  if (typeof rawScript !== "string" || rawScript.length === 0) {
    return skip('"script" is missing');
  }

  // Every warning from here on can name the hook, which is a better anchor for the reader than
  // "entry 2" once a script name exists to show them.
  const skipNamed = (reason: string) => ({
    spec: undefined,
    warning: `${filePath}: hook "${rawScript}" was skipped: ${reason}`,
  });

  if (!SCRIPT_NAME_SHAPE.test(rawScript)) {
    return skipNamed(
      '"script" must be a bare file name with no extension and no directory separator',
    );
  }

  let matcher: RegExp | undefined;
  const rawMatcher = fields.matcher;
  if (rawMatcher !== undefined) {
    if (typeof rawMatcher !== "string") {
      return skipNamed('"matcher" is not a string');
    }
    try {
      // Anchored so "edit" matches the tool `edit` and not the tail of `credit_check`.
      matcher = new RegExp(`^(?:${rawMatcher})$`);
    } catch (err) {
      return skipNamed(`"matcher" is not a valid regular expression (${messageOf(err)})`);
    }
  }

  let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
  const rawTimeout = fields.timeout;
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      return skipNamed('"timeout" must be a positive number of seconds');
    }
    timeoutMs = rawTimeout * 1000;
  }

  // Paired per OS, not by extension sniffing: the author writes one bare name and each platform
  // resolves its own half, so a hook missing on only one teammate's OS fails at session start
  // instead of silently never running there.
  const ext = opts.platform === "win32" ? "ps1" : "sh";
  const path = join(opts.dir, `${rawScript}.${ext}`);
  if (!opts.scriptExists(path)) {
    return skipNamed(
      `no ${rawScript}.${ext} in ${opts.dir} (${opts.platform} runs the .${ext} half of the pair)`,
    );
  }

  return {
    spec: { event, script: rawScript, path, matcher, timeoutMs, source: opts.source, filePath },
    warning: undefined,
  };
}

// Pure. `platform` and `scriptExists` are PARAMETERS, not reads of process.platform/node:fs, so
// both OS branches are testable from one machine — parseServersFile (mcp/registry.ts) uses the
// same idiom for its `env` parameter.
export function parseHooksFile(opts: {
  text: string;
  filePath: string;
  dir: string;
  source: ExtensionSource;
  platform?: NodeJS.Platform;
  scriptExists?: (path: string) => boolean;
}): HooksFileOutcome {
  const { filePath, dir, source } = opts;
  const platform = opts.platform ?? process.platform;
  const scriptExists = opts.scriptExists ?? existsSync;
  const warnings: string[] = [];

  let doc: unknown;
  try {
    doc = parse(opts.text);
  } catch (err) {
    warnings.push(`could not parse ${filePath}: it is not valid YAML (${messageOf(err)})`);
    return { specs: [], warnings };
  }
  // A bare `hooks.yaml` is a project that hasn't set any up yet, not a mistake — session start
  // must not warn about a file most projects will never create.
  if (doc === null || doc === undefined) return { specs: [], warnings };

  if (typeof doc !== "object" || Array.isArray(doc)) {
    warnings.push(`${filePath} was skipped: it is not a mapping of keys to values`);
    return { specs: [], warnings };
  }
  const hooks = (doc as Record<string, unknown>).hooks;
  if (hooks === undefined) {
    warnings.push(`${filePath}: "hooks" is missing`);
    return { specs: [], warnings };
  }
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    warnings.push(`${filePath}: "hooks" is not a mapping of keys to values`);
    return { specs: [], warnings };
  }

  const specs: HookSpec[] = [];
  for (const [eventKey, rawList] of Object.entries(hooks as Record<string, unknown>)) {
    if (!isHookEvent(eventKey)) {
      warnings.push(
        `${filePath}: unknown hook event "${eventKey}" (expected one of ${HOOK_EVENTS.join(", ")})`,
      );
      continue;
    }
    if (!Array.isArray(rawList)) {
      warnings.push(`${filePath}: "${eventKey}" is not a sequence of hooks`);
      continue;
    }
    rawList.forEach((raw, index) => {
      const { spec, warning } = parseOneHookEntry({
        event: eventKey,
        index,
        raw,
        filePath,
        dir,
        source,
        platform,
        scriptExists,
      });
      if (warning !== undefined) warnings.push(warning);
      if (spec !== undefined) specs.push(spec);
    });
  }
  return { specs, warnings };
}
