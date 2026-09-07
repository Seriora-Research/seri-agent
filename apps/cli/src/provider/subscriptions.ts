import type { ModelProvider } from "@seri/model-catalog";
import { hasLeftoverCodexSubscription, loadUsableCodexGrant } from "../auth/codexAuthStore";
import { hasXaiSubscription } from "../auth/xaiAuthStore";

export function codexSubscriptionActive(configDir?: string): boolean {
  if (configDir === undefined) return hasLeftoverCodexSubscription();
  return loadUsableCodexGrant(configDir) !== undefined;
}

export function subscribedProviders(configDir: string): ReadonlySet<ModelProvider> {
  const subscribed = new Set<ModelProvider>();
  if (hasXaiSubscription(configDir)) subscribed.add("xai");
  if (codexSubscriptionActive(configDir)) subscribed.add("openai");
  return subscribed;
}

export function modelPickerSubscribedProviders(
  configDir: string,
  overlayApplied: boolean,
): ReadonlySet<ModelProvider> {
  const subscribed = new Set(subscribedProviders(configDir));
  if (!overlayApplied) subscribed.delete("openai");
  return subscribed;
}
