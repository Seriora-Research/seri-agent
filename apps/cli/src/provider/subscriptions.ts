import type { ModelProvider } from "@seri/model-catalog";
import { hasXaiSubscription } from "../auth/xaiAuthStore";

// Deliberately NOT folded into provider/keys.ts's configuredProviders. That function answers
// "has an API key", and a subscription is not one — conflating them would make /setup's own key
// rows claim a key exists where none does. resolveRoute takes the two sets separately for the
// same reason.
export function subscribedProviders(configDir: string): ReadonlySet<ModelProvider> {
  const subscribed = new Set<ModelProvider>();
  if (hasXaiSubscription(configDir)) subscribed.add("xai");
  return subscribed;
}
