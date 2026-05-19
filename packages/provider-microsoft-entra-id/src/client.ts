import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  ClientSecretCredential,
  DeviceCodeCredential,
  type AuthenticationRecord,
  type TokenCredential,
  useIdentityPlugin,
} from "@azure/identity";
import { cachePersistencePlugin } from "@azure/identity-cache-persistence";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import * as z from "zod";

useIdentityPlugin(cachePersistencePlugin);

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

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

// ─── Authentication record persistence ───────────────────────────────────────

const AUTH_RECORD_PATH = join(
  homedir(),
  ".IdentityService",
  "infrasync-entra-record.json",
);

function isAuthenticationRecord(value: unknown): value is AuthenticationRecord {
  if (typeof value !== "object" || value === null) return false;
  return "tenantId" in value && "clientId" in value && "homeAccountId" in value;
}

async function loadAuthRecord(): Promise<AuthenticationRecord | undefined> {
  const raw = await readFile(AUTH_RECORD_PATH, "utf-8").catch(() => null);
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return isAuthenticationRecord(parsed) ? parsed : undefined;
}

async function saveAuthRecord(record: AuthenticationRecord): Promise<void> {
  await mkdir(dirname(AUTH_RECORD_PATH), { recursive: true });
  await writeFile(AUTH_RECORD_PATH, JSON.stringify(record, null, 2), "utf-8");
}

// ─── Credential and client construction ──────────────────────────────────────

/**
 * Build a `@azure/identity` TokenCredential from a validated provider config.
 *
 * device-code → loads a persisted AuthenticationRecord so subsequent runs
 *   acquire tokens silently from the OS-level cache. On first run (no record),
 *   triggers the device-code flow and saves the resulting record for reuse.
 *
 * client-credentials → non-interactive flow using a registered app secret.
 */
export async function buildCredential(
  config: MicrosoftEntraIdConfig,
): Promise<TokenCredential> {
  if (config.kind === "device-code") {
    const authenticationRecord = await loadAuthRecord();

    const credential = new DeviceCodeCredential({
      tenantId: config.tenantId,
      clientId: config.clientId,
      authenticationRecord,
      tokenCachePersistenceOptions: {
        enabled: true,
        name: "infrasync-entra",
        unsafeAllowUnencryptedStorage: true,
      },
      userPromptCallback: (info) => {
        console.log(info.message);
      },
    });

    // Always pre-warm the token before returning. This serialises auth so that
    // concurrent resource reads (which each call getToken internally) don't
    // each race to trigger their own device-code prompt when the cache is cold.
    const record = await credential.authenticate([GRAPH_DEFAULT_SCOPE]);
    if (record !== undefined && authenticationRecord === undefined) {
      await saveAuthRecord(record);
    }

    return credential;
  }

  return new ClientSecretCredential(
    config.tenantId,
    config.clientId,
    config.clientSecret,
  );
}

/**
 * Build a Microsoft Graph `Client` wrapping the supplied TokenCredential.
 */
export function buildGraphClient(credential: TokenCredential): Client {
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: [GRAPH_DEFAULT_SCOPE],
  });
  return Client.initWithMiddleware({ authProvider });
}
