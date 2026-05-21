import type {
  ResourceHandle,
  ResourceOptions,
  RefBuilder,
} from "@infrasync-org/core/handles";
import { createResourceHandle } from "@infrasync-org/core/handles";
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
import type {
  IdentitySecurityDefaultsEnforcementPolicyRefs,
  IdentitySecurityDefaultsEnforcementPolicySpec,
} from "./identity-security-defaults-enforcement-policy.js";
import { buildIdentitySecurityDefaultsEnforcementPolicyRefs } from "./identity-security-defaults-enforcement-policy.js";
import type {
  UserAuthenticationMethodsRefs,
  UserAuthenticationMethodsSpec,
} from "./user-authentication-methods.js";
import { buildUserAuthenticationMethodsRefs } from "./user-authentication-methods.js";
import type {
  UserSoftwareOathMethodRefs,
  UserSoftwareOathMethodSpec,
} from "./user-software-oath-method.js";
import { buildUserSoftwareOathMethodRefs } from "./user-software-oath-method.js";

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

  /**
   * Create an IdentitySecurityDefaultsEnforcementPolicy resource.
   * Ref surface: id, isEnabled.
   */
  identitySecurityDefaultsEnforcementPolicy(
    id: string,
    spec: IdentitySecurityDefaultsEnforcementPolicySpec,
    options?: ResourceOptions,
  ): ResourceHandle<
    IdentitySecurityDefaultsEnforcementPolicySpec,
    IdentitySecurityDefaultsEnforcementPolicyRefs
  >;

  /**
   * Create a UserAuthenticationMethods resource.
   * Ref surface: id, userPrincipalName, methodTypes.
   */
  userAuthenticationMethods(
    id: string,
    spec: UserAuthenticationMethodsSpec,
    options?: ResourceOptions,
  ): ResourceHandle<
    UserAuthenticationMethodsSpec,
    UserAuthenticationMethodsRefs
  >;

  /**
   * Create a UserSoftwareOathMethod resource.
   * Ref surface: id, userPrincipalName, methodId.
   */
  userSoftwareOathMethod(
    id: string,
    spec: UserSoftwareOathMethodSpec,
    options?: ResourceOptions,
  ): ResourceHandle<UserSoftwareOathMethodSpec, UserSoftwareOathMethodRefs>;
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

  identitySecurityDefaultsEnforcementPolicy(
    id: string,
    spec: IdentitySecurityDefaultsEnforcementPolicySpec,
    options?: ResourceOptions,
  ): ResourceHandle<
    IdentitySecurityDefaultsEnforcementPolicySpec,
    IdentitySecurityDefaultsEnforcementPolicyRefs
  > {
    return this.typedResource(
      "IdentitySecurityDefaultsEnforcementPolicy",
      id,
      spec,
      options,
      buildIdentitySecurityDefaultsEnforcementPolicyRefs,
    );
  }

  userAuthenticationMethods(
    id: string,
    spec: UserAuthenticationMethodsSpec,
    options?: ResourceOptions,
  ): ResourceHandle<
    UserAuthenticationMethodsSpec,
    UserAuthenticationMethodsRefs
  > {
    return this.typedResource(
      "UserAuthenticationMethods",
      id,
      spec,
      options,
      buildUserAuthenticationMethodsRefs,
    );
  }

  userSoftwareOathMethod(
    id: string,
    spec: UserSoftwareOathMethodSpec,
    options?: ResourceOptions,
  ): ResourceHandle<UserSoftwareOathMethodSpec, UserSoftwareOathMethodRefs> {
    return this.typedResource(
      "UserSoftwareOathMethod",
      id,
      spec,
      options,
      buildUserSoftwareOathMethodRefs,
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
