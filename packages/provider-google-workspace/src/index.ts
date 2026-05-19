/**
 * `@infrasync/google-workspace` adapter.
 *
 * Exposes the Cloud Identity Inbound SAML SSO Profiles API so a Google
 * Workspace customer can be configured as the SAML IdP for downstream service
 * providers (e.g. Microsoft Entra ID federation).
 */

import * as z from "zod";
import type {
  ProviderAdapter,
  ProviderPort,
  ResolvedScopes,
  ResourcePort,
  ResourceRegistry,
} from "@infrasync/core/provider";
import {
  defineProvider,
  ResourceRegistry as Registry,
} from "@infrasync/core/provider";
import { CloudIdentityClient, buildRequester } from "./client.js";
import { SamlAppResource } from "./saml-app.js";

// ─── Config schema ───────────────────────────────────────────────────────────

export const googleWorkspaceConfigSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("oauth-user"),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
    refreshToken: z.string().trim().min(1),
    customerId: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.literal("service-account"),
    serviceAccountKey: z.string().trim().min(1),
    subjectEmail: z.email(),
    customerId: z.string().trim().min(1),
  }),
]);

export type GoogleWorkspaceConfig = z.infer<typeof googleWorkspaceConfigSchema>;

// ─── Adapter descriptor ──────────────────────────────────────────────────────

/**
 * The Google Workspace adapter descriptor. Pass to `infra.provider()`:
 *
 * ```typescript
 * import { googleWorkspace } from "@infrasync/google-workspace";
 *
 * const gw = infra.provider("gw", googleWorkspace, {
 *   kind: "oauth-user",
 *   clientId: "...",
 *   clientSecret: infra.secret.env("GOOGLE_OAUTH_CLIENT_SECRET"),
 *   refreshToken: infra.secret.env("GOOGLE_OAUTH_REFRESH_TOKEN"),
 *   customerId: "C00xxxxxx",
 * });
 * ```
 */
export const googleWorkspace: ProviderAdapter<
  typeof googleWorkspaceConfigSchema
> = defineProvider("google-workspace", () => new GoogleWorkspaceProvider());

export class GoogleWorkspaceProvider implements ProviderPort<
  typeof googleWorkspaceConfigSchema
> {
  readonly name = "google-workspace";
  readonly configSchema = googleWorkspaceConfigSchema;

  /** Pluggable resource registry for extending Google Workspace resources. */
  readonly registry: ResourceRegistry = new Registry();

  private client: CloudIdentityClient | undefined;

  constructor() {
    this.registry.register("SamlApp", () => new SamlAppResource(this.client));
  }

  /** Returns the connected Cloud Identity client or throws if not connected. */
  connectedClient(): CloudIdentityClient {
    if (this.client === undefined) {
      throw new Error(
        "Google Workspace provider not connected — call connect() first",
      );
    }
    return this.client;
  }

  async connect(config: unknown): Promise<void> {
    const result = googleWorkspaceConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(
        `Google Workspace config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      );
    }
    const requester =
      result.data.kind === "oauth-user"
        ? buildRequester({
            kind: "oauth-user",
            clientId: result.data.clientId,
            clientSecret: result.data.clientSecret,
            refreshToken: result.data.refreshToken,
          })
        : buildRequester({
            kind: "service-account",
            serviceAccountKey: result.data.serviceAccountKey,
            subjectEmail: result.data.subjectEmail,
          });
    this.client = new CloudIdentityClient(requester, result.data.customerId);
    await Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.client = undefined;
    await Promise.resolve();
  }

  supportedKinds(): string[] {
    return this.registry.kinds();
  }

  resourceHandler(kind: string, scopes: ResolvedScopes): ResourcePort {
    return this.registry.create(kind, scopes);
  }
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export {
  samlAppSpecSchema,
  type SamlAppSpec,
  buildSamlAppRefs,
  type SamlAppRefs,
  SamlAppResource,
} from "./saml-app.js";

export {
  createGoogleWorkspaceHandle,
  type GoogleWorkspaceProviderHandle,
} from "./handle.js";
