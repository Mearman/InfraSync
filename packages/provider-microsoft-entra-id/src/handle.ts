import type {
  ResourceHandle,
  ResourceOptions,
  RefBuilder,
} from "@infrasync/core/handles";
import { createResourceHandle } from "@infrasync/core/handles";
import type { UserRefs, UserSpec } from "./user.js";
import { buildUserRefs } from "./user.js";
import type {
  DomainFederationConfigurationRefs,
  DomainFederationConfigurationSpec,
} from "./domain-federation-configuration.js";
import { buildDomainFederationConfigurationRefs } from "./domain-federation-configuration.js";
import type {
  FeatureRolloutPolicyRefs,
  FeatureRolloutPolicySpec,
} from "./feature-rollout-policy.js";
import { buildFeatureRolloutPolicyRefs } from "./feature-rollout-policy.js";

// ─── Registration function ───────────────────────────────────────────────────

export type ResourceRegistrar = (
  handle: ResourceHandle<unknown, unknown>,
) => void;

// ─── Typed handle ────────────────────────────────────────────────────────────

/**
 * Typed provider handle for Microsoft Entra ID resources.
 *
 * Created by {@link createMicrosoftEntraIdHandle}. Each method returns a
 * `ResourceHandle` with the correct spec type and a typed ref surface.
 */
export interface MicrosoftEntraIdProviderHandle {
  /** Provider instance key (e.g. "entra") */
  readonly instanceKey: string;

  /** Adapter name ("microsoft-entra-id") */
  readonly adapterName: string;

  /**
   * Create a User resource.
   * Ref surface: id, userPrincipalName.
   */
  user(
    id: string,
    spec: UserSpec,
    options?: ResourceOptions,
  ): ResourceHandle<UserSpec, UserRefs>;

  /**
   * Create a DomainFederationConfiguration resource.
   * Ref surface: id, domain, issuerUri.
   */
  domainFederationConfiguration(
    id: string,
    spec: DomainFederationConfigurationSpec,
    options?: ResourceOptions,
  ): ResourceHandle<
    DomainFederationConfigurationSpec,
    DomainFederationConfigurationRefs
  >;

  /**
   * Create a FeatureRolloutPolicy resource.
   * Ref surface: id, displayName, feature.
   */
  featureRolloutPolicy(
    id: string,
    spec: FeatureRolloutPolicySpec,
    options?: ResourceOptions,
  ): ResourceHandle<FeatureRolloutPolicySpec, FeatureRolloutPolicyRefs>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class MicrosoftEntraIdProviderHandleImpl implements MicrosoftEntraIdProviderHandle {
  constructor(
    readonly instanceKey: string,
    readonly adapterName: string,
    private readonly registerResource: ResourceRegistrar,
  ) {}

  user(
    id: string,
    spec: UserSpec,
    options?: ResourceOptions,
  ): ResourceHandle<UserSpec, UserRefs> {
    return this.typedResource("User", id, spec, options, buildUserRefs);
  }

  domainFederationConfiguration(
    id: string,
    spec: DomainFederationConfigurationSpec,
    options?: ResourceOptions,
  ): ResourceHandle<
    DomainFederationConfigurationSpec,
    DomainFederationConfigurationRefs
  > {
    return this.typedResource(
      "DomainFederationConfiguration",
      id,
      spec,
      options,
      buildDomainFederationConfigurationRefs,
    );
  }

  featureRolloutPolicy(
    id: string,
    spec: FeatureRolloutPolicySpec,
    options?: ResourceOptions,
  ): ResourceHandle<FeatureRolloutPolicySpec, FeatureRolloutPolicyRefs> {
    return this.typedResource(
      "FeatureRolloutPolicy",
      id,
      spec,
      options,
      buildFeatureRolloutPolicyRefs,
    );
  }

  private typedResource<TSpec, TRefs>(
    kind: string,
    id: string,
    spec: TSpec,
    options: ResourceOptions | undefined,
    buildRefs: RefBuilder<TRefs>,
  ): ResourceHandle<TSpec, TRefs> {
    const handle = createResourceHandle(
      id,
      this.instanceKey,
      kind,
      spec,
      options,
      buildRefs,
    );
    this.registerResource(handle);
    return handle;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a typed Microsoft Entra ID provider handle.
 *
 * ```typescript
 * const infra = defineInfra("prod", (infra) => {
 *   const base = infra.provider("entra", microsoftEntraId, { ... });
 *   const entra = createMicrosoftEntraIdHandle(
 *     base.instanceKey,
 *     base.adapterName,
 *     base.register,
 *   );
 *
 *   const alice = entra.user("alice", {
 *     kind: "User",
 *     userPrincipalName: "alice@example.com",
 *     displayName: "Alice Example",
 *     mailNickname: "alice",
 *     accountEnabled: true,
 *     usageLocation: "GB",
 *     userType: "Member",
 *     passwordProfile: { password: "..." },
 *   });
 * });
 * ```
 */
export function createMicrosoftEntraIdHandle(
  instanceKey: string,
  adapterName: string,
  registerResource: ResourceRegistrar,
): MicrosoftEntraIdProviderHandle {
  return new MicrosoftEntraIdProviderHandleImpl(
    instanceKey,
    adapterName,
    registerResource,
  );
}
