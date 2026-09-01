import type { ModelProvider } from "@seri/model-catalog";

// One credential class, two acquisitions. xAI implements RefreshSubscription with an OAuth
// refresh_token grant. OpenAI implements it by spawning `codex app-server`. Routing,
// credentialFor, reportForSubscription, the /setup row and the store consumers see this type
// and cannot tell which is which. Provider-specific stores (xai-auth.json, ~/.codex/auth.json)
// map onto this; callers that only need "is this a connected subscription, and whose token is
// it" never read those files.
export type SubscriptionCredential = {
  provider: ModelProvider;
  accessToken: string;
  accountId: string;
  // Unix ms. 0 means "no hint", never "expired" — the 401-retry path is the authority on
  // whether a token still works, matching AuthSession.expiresAt's missing-value rule.
  expiresAt: number;
};

// `undefined` is "not connected / could not refresh" for a caller that degrades. An
// implementation that treats failure as fatal (Codex's refresh throws) still matches: a
// resolved credential is assignable here.
export type RefreshSubscription = (
  configDir: string,
) => Promise<SubscriptionCredential | undefined>;
