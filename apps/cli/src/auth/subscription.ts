import type { ModelProvider } from "@seri/model-catalog";






export type SubscriptionCredential = {
  provider: ModelProvider;
  accessToken: string;
  accountId: string;


  expiresAt: number;
};




export type RefreshSubscription = (
  configDir: string,
) => Promise<SubscriptionCredential | undefined>;
