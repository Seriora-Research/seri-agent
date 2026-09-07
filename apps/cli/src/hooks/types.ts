



import type { ExtensionSource } from "../extensions/discovery";

export const HOOKS_FILENAME = "hooks.yaml";





export const HOOK_EVENTS = ["PreToolUse", "PostToolUse"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}




export const HOOK_BLOCK_EXIT_CODE = 2;




export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

export type HookSpec = {
  readonly event: HookEvent;



  readonly script: string;



  readonly path: string;


  readonly matcher: RegExp | undefined;
  readonly timeoutMs: number;
  readonly source: ExtensionSource;
  readonly filePath: string;
};



export type HookRegistry = ReadonlyMap<HookEvent, readonly HookSpec[]>;

export function hookMatches(spec: HookSpec, subject: string): boolean {
  return spec.matcher === undefined || spec.matcher.test(subject);
}















export type HookPayload = {
  readonly hook_event_name: HookEvent;
  readonly tool_name: string;
  readonly cwd: string;
  readonly tool_input: unknown;





  readonly tool_response?: unknown;
};







export type HookOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "failed"; readonly message: string };
