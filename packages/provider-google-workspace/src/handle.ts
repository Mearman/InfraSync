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
} from "@infrasync/core/handles";
import { createResourceHandle } from "@infrasync/core/handles";
import type {
  InboundSamlSsoProfileRefs,
  InboundSamlSsoProfileSpec,
} from "./inbound-saml-sso-profile.js";
import { buildInboundSamlSsoProfileRefs } from "./inbound-saml-sso-profile.js";

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
 * } from "@infrasync/google-workspace";
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
