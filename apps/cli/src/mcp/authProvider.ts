// seri implements no OAuth. auth() and the HTTP transport (@ai-sdk/mcp) run the whole 2.1 flow;
// this file is only the OAuthClientProvider they call back into for storage, for the one URL check
// they cannot make on our behalf, and for the decision of whether a login may start at all.
import { randomBytes } from "node:crypto";
import type { OAuthClientMetadata, OAuthClientProvider } from "@ai-sdk/mcp";
import {
  clearMcpServerAuth,
  loadMcpServerAuth,
  type McpServerAuth,
  saveMcpServerAuth,
} from "./authStore";
import type { McpServerSpec } from "./types";

// Registered together as this client's redirect URIs (see clientMetadata below) and tried in this
// order by startCallbackServer (mcp/loopback.ts).
export const MCP_CALLBACK_PORTS: readonly number[] = [41999, 42000, 42001, 42002];
export const MCP_CALLBACK_PATH = "/callback";

// The IP literal, never "localhost" (RFC 8252 §7.3): a name goes through the system resolver and
// can land on ::1 or on whatever a hosts file says, while 127.0.0.1 is the address the listener
// actually bound. The redirect URI a server has on file has to be the one the browser reaches.
export function mcpCallbackUri(port: number): string {
  return `http://127.0.0.1:${port}${MCP_CALLBACK_PATH}`;
}

// Thrown in place of starting a login. isAuthRequired (mcp/client.ts) is what turns it into a
// `needs-auth` status rather than a `failed` one, so the panel offers the fix instead of a stack.
export class McpLoginRequiredError extends Error {
  constructor(readonly server: string) {
    super(`MCP server "${server}" is not authenticated`);
    this.name = "McpLoginRequiredError";
  }
}

// The two personae one provider wears. `refuse` is what every dial gets (createSessionDial,
// mcp/client.ts): it spends stored credentials and refreshes them, but never starts a login.
// `redirect` is what /mcp auth builds (mcp/login.ts), with a listener already bound to
// `redirectUri` and waiting for the code.
export type McpAuthInteraction =
  | { readonly kind: "refuse" }
  | {
      readonly kind: "redirect";
      readonly redirectUri: string;
      readonly onRedirect: (url: URL) => void;
    };

export function createMcpAuthProvider(opts: {
  spec: Pick<McpServerSpec, "name" | "url">;
  configDir: string;
  interaction: McpAuthInteraction;
}): OAuthClientProvider {
  const { spec, configDir, interaction } = opts;
  const load = (): McpServerAuth | undefined => loadMcpServerAuth(configDir, spec.name, spec.url);
  const save = (patch: Partial<Omit<McpServerAuth, "serverUrl">>): void => {
    saveMcpServerAuth(configDir, spec.name, patch, spec.url);
  };

  // In memory for the life of this provider, never on disk. A login never crosses a process
  // boundary — the callback lands on a listener this same process is holding open — so there is
  // nothing to persist them for, and keeping them off disk is what stops a background dial's
  // silent refusal from clobbering the verifier of an interactive login running beside it.
  let codeVerifier: string | undefined;
  let state: string | undefined;

  return {
    tokens: () => load()?.tokens,
    saveTokens: (tokens) => {
      save({ tokens });
    },
    clientInformation: () => load()?.clientInformation,
    saveClientInformation: (clientInformation) => {
      save({ clientInformation });
    },
    authorizationServerInformation: () => load()?.authorizationServer,
    // Optional in the interface, mandatory in practice: auth() throws "OAuth authorization server
    // metadata must be saveable before starting authorization" for a provider without it.
    saveAuthorizationServerInformation: (authorizationServer) => {
      save({ authorizationServer });
    },

    saveCodeVerifier: (verifier) => {
      codeVerifier = verifier;
    },
    codeVerifier: () => {
      if (codeVerifier === undefined) {
        throw new Error(`no PKCE verifier for MCP server "${spec.name}": its login never started`);
      }
      return codeVerifier;
    },
    state: () => {
      state ??= randomBytes(32).toString("base64url");
      return state;
    },
    saveState: (value) => {
      state = value;
    },
    storedState: () => state,

    get redirectUrl(): string {
      // The refuse persona never serves this one — it throws before startAuthorization runs — but
      // startAuthorization reads the getter regardless, so it still has to name a real candidate.
      return interaction.kind === "redirect"
        ? interaction.redirectUri
        : mcpCallbackUri(MCP_CALLBACK_PORTS[0]);
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "seri",
        // All four candidates registered at once, so any port the listener manages to bind is
        // already a URI this client is registered for. "the port is taken by another app" and "two
        // seri processes logging in at once" then both collapse into "bind the next candidate",
        // with nothing about the choice persisted and no re-registration ever needed.
        redirect_uris: MCP_CALLBACK_PORTS.map(mcpCallbackUri),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // No token_endpoint_auth_method and no scope, deliberately: selectClientAuthMethod picks
        // the method out of what the authorization server itself advertises, and selectScope falls
        // back to the protected resource's own scopes_supported. Either field set here would
        // replace a correct answer with a guess.
      };
    },

    validateAuthorizationServerURL: (_serverUrl, authorizationServerUrl) => {
      // The authorize URL built from this one is handed to openBrowser (auth/browser.ts), which
      // shells out to `cmd /c start` on Windows. This URL came out of the MCP server's own
      // protected-resource metadata, so a hostile server must not get to nominate the scheme.
      if (new URL(authorizationServerUrl).protocol !== "https:") {
        throw new Error(
          `MCP server "${spec.name}" named a non-https authorization server: ${String(authorizationServerUrl)}`,
        );
      }
      if (interaction.kind !== "refuse") return;
      // This hook and not redirectToAuthorization, because it is the only one auth() runs BEFORE
      // dynamic client registration: a background tool call — or an unattended scheduled run —
      // must never create an OAuth app on the user's account as a side effect of dialling. A
      // record holding both halves passes, so refreshing still works: that branch returns
      // AUTHORIZED without ever reaching redirectToAuthorization.
      const stored = load();
      if (stored?.tokens === undefined || stored.clientInformation === undefined) {
        throw new McpLoginRequiredError(spec.name);
      }
    },

    redirectToAuthorization: (authorizationUrl) => {
      // Belt and braces. validateAuthorizationServerURL already refused every login with nothing
      // stored; this is the one path a record WITH tokens still reaches, when its refresh failed
      // and auth() fell through to a fresh authorization.
      if (interaction.kind === "refuse") throw new McpLoginRequiredError(spec.name);
      interaction.onRedirect(authorizationUrl);
    },

    // What makes a dead refresh token self-heal without anyone deleting a file: auth()'s own catch
    // maps InvalidClient/UnauthorizedClient to "all" and InvalidGrant to "tokens", then retries
    // once. Omit this and those errors just propagate.
    invalidateCredentials: (scope) => {
      if (scope === "all" || scope === "client") clearMcpServerAuth(configDir, spec.name);
      else if (scope === "tokens") save({ tokens: undefined });
      else if (scope === "verifier") codeVerifier = undefined;
    },
  };
}
