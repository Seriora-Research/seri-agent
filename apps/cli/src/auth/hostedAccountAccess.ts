import { type AuthSession, loadAuthSession } from "./authStore";

export type HostedAccountAccess = "offered" | "unavailable";

declare const SERI_BAKED_HOSTED_ACCOUNTS: boolean | undefined;

export const HOSTED_ACCOUNTS_UNAVAILABLE_MESSAGE =
  "Hosted accounts are not available in this build.";

export class HostedAccountsUnavailable extends Error {
  readonly code = "hosted-accounts-unavailable";
  constructor() {
    super(HOSTED_ACCOUNTS_UNAVAILABLE_MESSAGE);
    this.name = "HostedAccountsUnavailable";
  }
}

function readBakedHostedAccounts(): boolean | undefined {
  return typeof SERI_BAKED_HOSTED_ACCOUNTS === "boolean" ? SERI_BAKED_HOSTED_ACCOUNTS : undefined;
}

export function hostedAccountAccess(
  baked: boolean | undefined = readBakedHostedAccounts(),
): HostedAccountAccess {
  return baked === false ? "unavailable" : "offered";
}

export function splashAuthItems(
  access: HostedAccountAccess,
  sessionMissing: boolean,
): readonly { label: string; action: "login" | "signup" | "continue" }[] {
  if (access === "unavailable") {
    return [{ label: "Continue", action: "continue" }];
  }
  if (sessionMissing) {
    return [
      { label: "Log in", action: "login" },
      { label: "Sign up", action: "signup" },
      { label: "Continue without logging in", action: "continue" },
    ];
  }
  return [{ label: "Continue", action: "continue" }];
}

export function hostedCommandVisible(name: string, access: HostedAccountAccess): boolean {
  if (access === "unavailable" && (name === "/login" || name === "/signup")) return false;
  return true;
}

export function liveHostedSession(
  configDir: string,
  access: HostedAccountAccess = hostedAccountAccess(),
): AuthSession | undefined {
  if (access === "unavailable") return undefined;
  return loadAuthSession(configDir);
}
