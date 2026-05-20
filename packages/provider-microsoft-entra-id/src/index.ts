import type { Client } from "@microsoft/microsoft-graph-client";
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
import {
  buildCredential,
  buildGraphClient,
  microsoftEntraIdConfigSchema,
} from "./client.js";
import { UserResource } from "./user.js";
import { DomainFederationConfigurationResource } from "./domain-federation-configuration.js";
import { FeatureRolloutPolicyResource } from "./feature-rollout-policy.js";

// ─── Adapter descriptor ──────────────────────────────────────────────────────

/**
 * The Microsoft Entra ID adapter descriptor. Pass this to `infra.provider()`:
 *
 * ```typescript
 * import { microsoftEntraId } from "@infrasync/microsoft-entra-id";
 *
 * const entra = infra.provider("entra", microsoftEntraId, {
 *   kind: "client-credentials",
 *   tenantId: "...",
 *   clientId: "...",
 *   clientSecret: infra.secret.env("ENTRA_CLIENT_SECRET"),
 * });
 * ```
 */
export const microsoftEntraId: ProviderAdapter<
  typeof microsoftEntraIdConfigSchema
> = defineProvider("microsoft-entra-id", () => new MicrosoftEntraIdProvider());

export class MicrosoftEntraIdProvider implements ProviderPort<
  typeof microsoftEntraIdConfigSchema
> {
  readonly name = "microsoft-entra-id";
  readonly configSchema = microsoftEntraIdConfigSchema;

  /** Pluggable registry for extending Entra ID resources. */
  readonly registry: ResourceRegistry = new Registry();

  private client: Client | undefined;

  constructor() {
    this.registry.register("User", () => {
      const client = this.connectedClient();
      return new UserResource(client);
    });

    this.registry.register("DomainFederationConfiguration", () => {
      const client = this.connectedClient();
      return new DomainFederationConfigurationResource(client);
    });

    this.registry.register("FeatureRolloutPolicy", () => {
      const client = this.connectedClient();
      return new FeatureRolloutPolicyResource(client);
    });
  }

  /**
   * Return the connected Graph client, or throw if `connect()` has not yet
   * been called. Narrowing helper — keeps registry closures free of type
   * assertions.
   */
  connectedClient(): Client {
    if (this.client === undefined) {
      throw new Error(
        "Microsoft Entra ID provider not connected — call connect() first",
      );
    }
    return this.client;
  }

  async connect(config: unknown): Promise<void> {
    const result = microsoftEntraIdConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(
        `Microsoft Entra ID config validation failed: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", ")}`,
      );
    }
    const credential = await buildCredential(result.data);
    this.client = buildGraphClient(credential);
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
  microsoftEntraIdConfigSchema,
  type MicrosoftEntraIdConfig,
  buildCredential,
  buildGraphClient,
} from "./client.js";
export {
  UserResource,
  userSpecSchema,
  buildUserRefs,
  type UserSpec,
  type UserRefs,
} from "./user.js";
export {
  DomainFederationConfigurationResource,
  domainFederationConfigurationSpecSchema,
  buildDomainFederationConfigurationRefs,
  type DomainFederationConfigurationSpec,
  type DomainFederationConfigurationRefs,
} from "./domain-federation-configuration.js";
export {
  createMicrosoftEntraIdHandle,
  type MicrosoftEntraIdProviderHandle,
} from "./handle.js";
export {
  FeatureRolloutPolicyResource,
  featureRolloutPolicySpecSchema,
  buildFeatureRolloutPolicyRefs,
  type FeatureRolloutPolicySpec,
  type FeatureRolloutPolicyRefs,
} from "./feature-rollout-policy.js";
