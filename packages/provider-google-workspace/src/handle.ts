/**
 * Typed authoring-time handle for the Google Workspace provider.
 *
 * Mirrors the Cloudflare pattern (`createCloudflareHandle`) so callers get
 * typed methods like `gw.inboundSamlSsoProfile(...)` with strongly typed ref surfaces.
 */

import type {
  ResourceHandle,
  ResourceOptions,
  RefBuilder,
} from "@infrasync-org/core/handles";
import { createResourceHandle } from "@infrasync-org/core/handles";
import type {
  InboundSamlSsoProfileRefs,
  InboundSamlSsoProfileSpec,
} from "./inbound-saml-sso-profile.js";
import { buildInboundSamlSsoProfileRefs } from "./inbound-saml-sso-profile.js";
import type {
  DirectorySchemaRefs,
  DirectorySchemaSpec,
} from "./directory-schema.js";
import { buildDirectorySchemaRefs } from "./directory-schema.js";
import type {
  UserCustomAttributeRefs,
  UserCustomAttributeSpec,
} from "./user-custom-attribute.js";
import { buildUserCustomAttributeRefs } from "./user-custom-attribute.js";

// ─── Registration function ───────────────────────────────────────────────────

/**
 * Function that registers a resource handle with the authoring scope.
 * Obtained from the base `ProviderHandle.register` returned by
 * `infra.provider(...)`.
 */
export type ResourceRegistrar = (
  handle: ResourceHandle<unknown, unknown>,
) => void;

// ─── Typed Google Workspace handle ───────────────────────────────────────────

export interface GoogleWorkspaceProviderHandle {
  /** Provider instance key (e.g. "gw") */
  readonly instanceKey: string;

  /** Adapter name ("google-workspace") */
  readonly adapterName: string;

  /**
   * Create a SAML application (Cloud Identity inboundSamlSsoProfile).
   * Returns a handle with typed ref surface (id, name, displayName).
   */
  inboundSamlSsoProfile(
    id: string,
    spec: InboundSamlSsoProfileSpec,
    options?: ResourceOptions,
  ): ResourceHandle<InboundSamlSsoProfileSpec, InboundSamlSsoProfileRefs>;

  /**
   * Create a custom user schema (Directory API schemas resource).
   * Returns a handle with typed ref surface (schemaId, schemaName).
   */
  directorySchema(
    id: string,
    spec: DirectorySchemaSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DirectorySchemaSpec, DirectorySchemaRefs>;

  /**
   * Set a custom attribute value on a user profile.
   * Returns a handle with typed ref surface (value).
   */
  userCustomAttribute(
    id: string,
    spec: UserCustomAttributeSpec,
    options?: ResourceOptions,
  ): ResourceHandle<UserCustomAttributeSpec, UserCustomAttributeRefs>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class GoogleWorkspaceProviderHandleImpl implements GoogleWorkspaceProviderHandle {
  constructor(
    readonly instanceKey: string,
    readonly adapterName: string,
    private readonly registerResource: ResourceRegistrar,
  ) {}

  inboundSamlSsoProfile(
    id: string,
    spec: InboundSamlSsoProfileSpec,
    options?: ResourceOptions,
  ): ResourceHandle<InboundSamlSsoProfileSpec, InboundSamlSsoProfileRefs> {
    return this.typedResource(
      "InboundSamlSsoProfile",
      id,
      spec,
      options,
      buildInboundSamlSsoProfileRefs,
    );
  }

  directorySchema(
    id: string,
    spec: DirectorySchemaSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DirectorySchemaSpec, DirectorySchemaRefs> {
    return this.typedResource(
      "DirectorySchema",
      id,
      spec,
      options,
      buildDirectorySchemaRefs,
    );
  }

  userCustomAttribute(
    id: string,
    spec: UserCustomAttributeSpec,
    options?: ResourceOptions,
  ): ResourceHandle<UserCustomAttributeSpec, UserCustomAttributeRefs> {
    return this.typedResource(
      "UserCustomAttribute",
      id,
      spec,
      options,
      buildUserCustomAttributeRefs,
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
 * Create a typed Google Workspace provider handle.
 *
 * ```typescript
 * import {
 *   googleWorkspace,
 *   createGoogleWorkspaceHandle,
 * } from "@infrasync-org/google-workspace";
 *
 * const infra = defineInfra("prod", (infra) => {
 *   const baseGw = infra.provider("gw", googleWorkspace, {
 *     kind: "oauth-user",
 *     // …
 *   });
 *   const gw = createGoogleWorkspaceHandle(
 *     baseGw.instanceKey,
 *     baseGw.adapterName,
 *     baseGw.register,
 *   );
 *
 *   gw.inboundSamlSsoProfile("m365", {
 *     kind: "InboundSamlSsoProfile",
 *     displayName: "Microsoft 365",
 *     idpConfig: { ... },
 *     spConfig: { ... },
 *   });
 * });
 * ```
 */
export function createGoogleWorkspaceHandle(
  instanceKey: string,
  adapterName: string,
  registerResource: ResourceRegistrar,
): GoogleWorkspaceProviderHandle {
  return new GoogleWorkspaceProviderHandleImpl(
    instanceKey,
    adapterName,
    registerResource,
  );
}
