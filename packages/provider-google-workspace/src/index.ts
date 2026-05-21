/**
 * `@infrasync-org/google-workspace` adapter.
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
} from "@infrasync-org/core/provider";
import {
  defineProvider,
  ResourceRegistry as Registry,
} from "@infrasync-org/core/provider";
import {
  CloudIdentityClient,
  buildRequester,
  DirectoryClient,
  buildDirectoryWriteRequester,
} from "./client.js";
import { InboundSamlSsoProfileResource } from "./inbound-saml-sso-profile.js";
import { DirectorySchemaResource } from "./directory-schema.js";
import { UserCustomAttributeResource } from "./user-custom-attribute.js";

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
 * import { googleWorkspace } from "@infrasync-org/google-workspace";
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
  private directoryClient: DirectoryClient | undefined;

  constructor() {
    this.registry.register(
      "InboundSamlSsoProfile",
      () => new InboundSamlSsoProfileResource(this.client),
    );
    this.registry.register(
      "DirectorySchema",
      () => new DirectorySchemaResource(this.directoryClient),
    );
    this.registry.register(
      "UserCustomAttribute",
      () => new UserCustomAttributeResource(this.directoryClient),
    );
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

  /** Returns the connected Directory client or throws if not connected. */
  connectedDirectoryClient(): DirectoryClient {
    if (this.directoryClient === undefined) {
      throw new Error(
        "Google Workspace provider not connected — call connect() first",
      );
    }
    return this.directoryClient;
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

    // Build a Directory client with write scopes for schema/attribute management
    const directoryRequester =
      result.data.kind === "oauth-user"
        ? buildDirectoryWriteRequester({
            kind: "oauth-user",
            clientId: result.data.clientId,
            clientSecret: result.data.clientSecret,
            refreshToken: result.data.refreshToken,
          })
        : buildDirectoryWriteRequester({
            kind: "service-account",
            serviceAccountKey: result.data.serviceAccountKey,
            subjectEmail: result.data.subjectEmail,
          });
    this.directoryClient = new DirectoryClient(
      directoryRequester,
      result.data.customerId,
    );

    await Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.client = undefined;
    this.directoryClient = undefined;
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
  inboundSamlSsoProfileSpecSchema,
  type InboundSamlSsoProfileSpec,
  buildInboundSamlSsoProfileRefs,
  type InboundSamlSsoProfileRefs,
  InboundSamlSsoProfileResource,
} from "./inbound-saml-sso-profile.js";

export {
  directorySchemaSpecSchema,
  type DirectorySchemaSpec,
  type SchemaFieldSpec,
  buildDirectorySchemaRefs,
  type DirectorySchemaRefs,
  DirectorySchemaResource,
} from "./directory-schema.js";

export {
  userCustomAttributeSpecSchema,
  type UserCustomAttributeSpec,
  buildUserCustomAttributeRefs,
  type UserCustomAttributeRefs,
  UserCustomAttributeResource,
} from "./user-custom-attribute.js";

export {
  createGoogleWorkspaceHandle,
  type GoogleWorkspaceProviderHandle,
} from "./handle.js";

export {
  DirectoryClient,
  buildDirectoryRequester,
  buildDirectoryWriteRequester,
  type DirectoryUser,
  directoryUserSchema,
} from "./client.js";
