import type { ModelProvider } from "@seri/model-catalog";

// The credential class every vendor subscription presents to routing, cost, and /setup.
// Provider-specific stores (xai-auth.json, a future Codex adapter) map onto this; callers that
// only need "is this a connected subscription, and whose token is it" never read those files.
export type SubscriptionCredential = {
  provider: ModelProvider;
  accessToken: string;
  accountId: string;
  expiresAt: number;
};

export type RefreshSubscription = (
  configDir: string,
) => Promise<SubscriptionCredential | undefined>;
