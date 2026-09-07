


import { randomBytes } from "node:crypto";
import type { OAuthClientMetadata, OAuthClientProvider } from "@ai-sdk/mcp";
import {
  clearMcpServerAuth,
  loadMcpServerAuth,
  type McpServerAuth,
  saveMcpServerAuth,
} from "./authStore";
import type { McpServerSpec } from "./types";



export const MCP_CALLBACK_PORTS: readonly number[] = [41999, 42000, 42001, 42002];
export const MCP_CALLBACK_PATH = "/callback";




// RFC 8252 §7.3: 127.0.0.1, never "localhost" — a name can resolve to ::1 or a hosts-file hijack.
export function mcpCallbackUri(port: number): string {
  return `http://127.0.0.1:${port}${MCP_CALLBACK_PATH}`;
}



export class McpLoginRequiredError extends Error {
  constructor(readonly server: string) {
    super(`MCP server "${server}" is not authenticated`);
    this.name = "McpLoginRequiredError";
  }
}





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


      return interaction.kind === "redirect"
        ? interaction.redirectUri
        : mcpCallbackUri(MCP_CALLBACK_PORTS[0]);
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "seri",




        redirect_uris: MCP_CALLBACK_PORTS.map(mcpCallbackUri),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],




      };
    },

    validateAuthorizationServerURL: (_serverUrl, authorizationServerUrl) => {



      if (new URL(authorizationServerUrl).protocol !== "https:") {
        throw new Error(
          `MCP server "${spec.name}" named a non-https authorization server: ${String(authorizationServerUrl)}`,
        );
      }
      if (interaction.kind !== "refuse") return;





      const stored = load();
      if (stored?.tokens === undefined || stored.clientInformation === undefined) {
        throw new McpLoginRequiredError(spec.name);
      }
    },

    redirectToAuthorization: (authorizationUrl) => {



      if (interaction.kind === "refuse") throw new McpLoginRequiredError(spec.name);
      interaction.onRedirect(authorizationUrl);
    },




    invalidateCredentials: (scope) => {
      if (scope === "all" || scope === "client") clearMcpServerAuth(configDir, spec.name);
      else if (scope === "tokens") save({ tokens: undefined });
      else if (scope === "verifier") codeVerifier = undefined;
    },
  };
}
