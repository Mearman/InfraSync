import {
  ClientSecretCredential,
  DeviceCodeCredential,
  type TokenCredential,
} from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import * as z from "zod";

// ─── Config schema (discriminated union) ─────────────────────────────────────

export const microsoftEntraIdConfigSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("device-code"),
    tenantId: z.string().trim().min(1),
    clientId: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.literal("client-credentials"),
    tenantId: z.string().trim().min(1),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
  }),
]);

export type MicrosoftEntraIdConfig = z.infer<
  typeof microsoftEntraIdConfigSchema
>;

// ─── Graph scope ─────────────────────────────────────────────────────────────

/**
 * Default Microsoft Graph scope. `.default` requests every static permission
 * the registered application has been granted in the tenant.
 */
const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

// ─── Credential and client construction ──────────────────────────────────────

/**
 * Build a `@azure/identity` TokenCredential from a validated provider config.
 *
 * device-code → interactive flow logging the user prompt to stdout.
 * client-credentials → non-interactive flow using a registered app secret.
 */
export function buildCredential(
  config: MicrosoftEntraIdConfig,
): TokenCredential {
  if (config.kind === "device-code") {
    return new DeviceCodeCredential({
      tenantId: config.tenantId,
      clientId: config.clientId,
      userPromptCallback: (info) => {
        console.log(info.message);
      },
    });
  }
  return new ClientSecretCredential(
    config.tenantId,
    config.clientId,
    config.clientSecret,
  );
}

/**
 * Build a Microsoft Graph `Client` wrapping the supplied TokenCredential.
 *
 * Uses the `.default` Graph scope — the registered application must already
 * carry every permission required by the resources being managed.
 */
export function buildGraphClient(credential: TokenCredential): Client {
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: [GRAPH_DEFAULT_SCOPE],
  });
  return Client.initWithMiddleware({ authProvider });
}
