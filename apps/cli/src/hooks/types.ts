// Zero runtime imports, the same discipline mcp/types.ts keeps and for the same reason: this module
// is imported by the loop seam, by the runner, and by config/paths.ts's neighbours, and a runtime
// import here is how an import cycle gets closed by accident. The one import below is type-only, so
// it is erased before anything cycles.
import type { ExtensionSource } from "../extensions/discovery";

export const HOOKS_FILENAME = "hooks.yaml";

// The loop edges a hook can be attached to. A tuple, not a bare union, because the parser needs to
// name the legal keys back to the user in a warning and a second hand-written list would drift from
// the type on the first addition. Two members today; the file layout, the runner and the payload
// are all event-agnostic, so a third is one member here plus one firing site.
export const HOOK_EVENTS = ["PreToolUse", "PostToolUse"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

// Claude Code's and Cursor's contract, unchanged, because interoperability is the feature — the
// scripts in this repo's own .cursor/hooks/ implement exactly this and must run under seri without
// an edit. 2 is the one exit code that means anything; see HookOutcome for what the others do.
export const HOOK_BLOCK_EXIT_CODE = 2;

// Long enough for a formatter or a typecheck, short enough that a wedged hook does not look like a
// hung agent. spawnCollect's own default is 120s, which is a fine ceiling for a command the model
// asked for and much too long for a gate that sits in front of every tool call.
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

export type HookSpec = {
  readonly event: HookEvent;
  // The bare name written in hooks.yaml, with no extension and no separator — kept alongside the
  // resolved path because every warning and every /hooks row names what the author wrote, not the
  // platform-specific file the author never typed.
  readonly script: string;
  // The platform's half of the pair: <dir>/<script>.ps1 on win32, <dir>/<script>.sh elsewhere.
  // Resolved once, at load, so a missing pair is one warning at session start rather than a
  // surprise in front of a tool call.
  readonly path: string;
  // Compiled at parse time and anchored, so "edit" is the tool `edit` and not the tail of
  // `credit_check`. undefined matches every tool, which is what an entry with no matcher means.
  readonly matcher: RegExp | undefined;
  readonly timeoutMs: number;
  readonly source: ExtensionSource;
  readonly filePath: string;
};

// Keyed by event so the firing site is a lookup, not a filter over one flat list re-scanned on
// every tool call. An event with no hooks is absent rather than present-and-empty.
export type HookRegistry = ReadonlyMap<HookEvent, readonly HookSpec[]>;

export function hookMatches(spec: HookSpec, subject: string): boolean {
  return spec.matcher === undefined || spec.matcher.test(subject);
}

// What the script reads on stdin. The field names are Claude Code's wire names, snake_case
// included, and that is the whole point: interoperability is the feature ADR 0013 names, and a
// ported script reads these keys by name. Measured rather than assumed — the first cut used
// `{ event, tool, input }` on the theory that the reference scripts grep the raw JSON text, which
// is true of `.cursor/hooks/block-dangerous.sh` and false of its `.ps1` twin: that one does
// `($payload | ConvertFrom-Json).tool_input.command`, so a renamed envelope silently found no
// command and let `rm -rf /` through. A structural reader is the case a regex reader hides.
//
// `tool_input` is nested rather than spread for the reason spreading would break: a tool argument
// named `cwd` would shadow the envelope's own.
//
// What does NOT carry over is the tool NAMES. seri's are `write_file`, `edit`, `bash`; Claude
// Code's are `Write`, `Edit`, `Bash`. A ported script that switches on the name needs its matcher
// rewritten, and the matcher lives in hooks.yaml, which its author is writing regardless.
export type HookPayload = {
  readonly hook_event_name: HookEvent;
  readonly tool_name: string;
  readonly cwd: string;
  readonly tool_input: unknown;
};

// Three outcomes rather than a boolean plus a nullable string. A block always has a reason (the
// script's stderr, or a stand-in when it printed nothing) and a failure always has a message, so
// neither can be constructed without the thing the caller has to render. "failed" is deliberately
// not "block": a hook that could not run has expressed no opinion, and turning a broken script into
// a deny would make a typo in a formatter stop the agent working. The spec's own verify line — a
// hook that exits non-zero does not take the session down — is this member.
export type HookOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "failed"; readonly message: string };
