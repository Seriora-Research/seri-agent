import type { ModelProvider } from "@seri/model-catalog";
import { hasCodexSubscription } from "../auth/codexAuthStore";
import { isCodexSubscriptionIgnored } from "../auth/codexIgnore";
import { hasXaiSubscription } from "../auth/xaiAuthStore";

export function codexSubscriptionActive(configDir?: string): boolean {
  if (!hasCodexSubscription()) return false;
  if (configDir === undefined) return true;
  return !isCodexSubscriptionIgnored(configDir);
}

// Deliberately NOT folded into provider/keys.ts's configuredProviders. That function answers
// "has an API key", and a subscription is not one — conflating them would make /setup's own key
// rows claim a key exists where none does. resolveRoute takes the two sets separately for the
// same reason.
export function subscribedProviders(configDir: string): ReadonlySet<ModelProvider> {
  const subscribed = new Set<ModelProvider>();
  if (hasXaiSubscription(configDir)) subscribed.add("xai");
  if (codexSubscriptionActive(configDir)) subscribed.add("openai");
  return subscribed;
}

// /model's Route column. Grok is labeled from the persisted grant. openai is labeled
// only after a successful Codex overlay. A chatgpt login without that overlay still
// shows the API catalog, and those rows are not plan-included.
export function modelPickerSubscribedProviders(
  configDir: string,
  overlayApplied: boolean,
): ReadonlySet<ModelProvider> {
  const subscribed = new Set(subscribedProviders(configDir));
  if (!overlayApplied) subscribed.delete("openai");
  return subscribed;
}
