import type { ModelProvider } from "@seri/model-catalog";

// One credential class, two acquisitions. xAI implements RefreshSubscription with an OAuth
// refresh_token grant. OpenAI implements it by spawning `codex app-server`. Routing,
// credentialFor, reportForSubscription, the /setup row and the store consumers see this type
// and cannot tell which is which.
export type SubscriptionCredential = {
  provider: ModelProvider;
  accessToken: string;
  accountId: string;
  // Unix ms. 0 means "no hint", never "expired" — the 401-retry path is the authority on
  // whether a token still works, matching AuthSession.expiresAt's missing-value rule.
  expiresAt: number;
};

export type RefreshSubscription = (configDir: string) => Promise<SubscriptionCredential>;
