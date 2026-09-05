import type { PermissionMode } from "./gate";
import type { CallLocation } from "./workingDir";
import type { ToolClass } from "../provider/tools";

export type Consent = "unasked" | "allowed-this-run" | "denied-this-run";

export type ConsentEvent = { type: "granted" } | { type: "declined" };

export type PolicyFact = {
  mode: PermissionMode;
  toolClass: ToolClass;
  location: CallLocation;
  consent: Consent;
  standingDeny: boolean;
  hasPrompt: boolean;
};

export type FsPolicyVerdict = "name-gate" | "block" | "ask";

type UnaskedOutsideKey = `${ToolClass}:${PermissionMode}:${"prompt" | "noprompt"}`;

// Write + auto asks with a prompt and blocks without one, because checkPermission would allow the write.
// Write + approve-each also asks, so a persisted write_file grant cannot skip the folder question.
// Write + read-only defers. Asking would let a yes bypass read-only.
export const UNASKED_OUTSIDE: { readonly [K in UnaskedOutsideKey]: FsPolicyVerdict } = {
  "read:auto:prompt": "ask",
  "read:auto:noprompt": "block",
  "read:approve-each:prompt": "ask",
  "read:approve-each:noprompt": "block",
  "read:read-only:prompt": "ask",
  "read:read-only:noprompt": "block",
  "write:auto:prompt": "ask",
  "write:auto:noprompt": "block",
  "write:approve-each:prompt": "ask",
  "write:approve-each:noprompt": "block",
  "write:read-only:prompt": "name-gate",
  "write:read-only:noprompt": "name-gate",
};

export function unaskedOutsideKey(fact: PolicyFact): UnaskedOutsideKey {
  return `${fact.toolClass}:${fact.mode}:${fact.hasPrompt ? "prompt" : "noprompt"}`;
}

export function decideFsPolicy(fact: PolicyFact): FsPolicyVerdict {
  if (fact.location !== "outside") return "name-gate";
  if (fact.standingDeny) return "block";
  if (fact.consent === "denied-this-run") return "block";
  if (fact.consent === "allowed-this-run") return "name-gate";
  return UNASKED_OUTSIDE[unaskedOutsideKey(fact)];
}

// One-shot latch. Terminal states ignore further events so a retried prompt cannot flip a no
// into a yes, or the other way around.
export function reduceConsent(current: Consent, event: ConsentEvent): Consent {
  if (current !== "unasked") return current;
  return event.type === "granted" ? "allowed-this-run" : "denied-this-run";
}
