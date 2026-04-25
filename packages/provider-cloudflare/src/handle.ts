import type {
  ResourceHandle,
  ResourceOptions,
  RefBuilder,
} from "@infrasync/core/handles";
import { createResourceHandle } from "@infrasync/core/handles";
import type { DnsRecordRefs } from "./dns-record.js";
import { buildDnsRecordRefs } from "./dns-record.js";
import type { AccessApplicationRefs } from "./access-app.js";
import { buildAccessApplicationRefs } from "./access-app.js";
import type { AccessPolicyRefs } from "./access-policy.js";
import { buildAccessPolicyRefs } from "./access-policy.js";
import type { IdentityProviderRefs } from "./identity-provider.js";
import { buildIdentityProviderRefs } from "./identity-provider.js";
import type { PagesCustomDomainRefs } from "./pages-domain.js";
import { buildPagesCustomDomainRefs } from "./pages-domain.js";
import type { DnsRecordSpec } from "@infrasync/core/dns-record";
import type { AccessApplicationSpec } from "./access-app.js";
import type { AccessPolicySpec } from "./access-policy.js";
import type { IdentityProviderSpec } from "./identity-provider.js";
import type { PagesCustomDomainSpec } from "./pages-domain.js";

// ─── Registration function ───────────────────────────────────────────────────

/**
 * Function that registers a resource handle with the authoring scope.
 * Extracted from ProviderHandle to avoid coupling typed handles
 * to the base handle's internal state.
 */
export type ResourceRegistrar = (
  handle: ResourceHandle<unknown, unknown>,
) => void;

// ─── Typed Cloudflare handle ─────────────────────────────────────────────────

/**
 * A typed provider handle for Cloudflare resources.
 *
 * Created by `createCloudflareHandle()`. Each method returns a
 * `ResourceHandle` with the correct spec type and typed ref surface.
 *
 * Usage:
 *
 * ```typescript
 * const infra = defineInfra("prod", (infra) => {
 *   const cf = infra.provider("cf", cloudflare, { ... });
 *   const cfTyped = createCloudflareHandle(cf.instanceKey, cf.adapterName, cf.register);
 *
 *   const record = cfTyped.dnsRecord("www", {
 *     kind: "DnsRecord",
 *     domain: "www.example.com",
 *     type: "CNAME",
 *     value: "target.example.com",
 *   });
 *   record.ref.name; // RefToken — typed
 * });
 * ```
 */
export interface CloudflareProviderHandle {
  /** Provider instance key (e.g. "cf") */
  readonly instanceKey: string;

  /** Adapter name ("cloudflare") */
  readonly adapterName: string;

  /**
   * Create a DNS record resource.
   * Returns a handle with typed ref surface (id, name, content, proxied, ttl).
   */
  dnsRecord(
    id: string,
    spec: DnsRecordSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DnsRecordSpec, DnsRecordRefs>;

  /**
   * Create an Access Application resource.
   * Returns a handle with typed ref surface (id, domain, name, aud).
   */
  accessApplication(
    id: string,
    spec: AccessApplicationSpec,
    options?: ResourceOptions,
  ): ResourceHandle<AccessApplicationSpec, AccessApplicationRefs>;

  /**
   * Create an Access Policy resource.
   * Returns a handle with typed ref surface (id, name).
   */
  accessPolicy(
    id: string,
    spec: AccessPolicySpec,
    options?: ResourceOptions,
  ): ResourceHandle<AccessPolicySpec, AccessPolicyRefs>;

  /**
   * Create an Identity Provider resource.
   * Returns a handle with typed ref surface (id, name, type).
   */
  identityProvider(
    id: string,
    spec: IdentityProviderSpec,
    options?: ResourceOptions,
  ): ResourceHandle<IdentityProviderSpec, IdentityProviderRefs>;

  /**
   * Create a Pages Custom Domain resource.
   * Returns a handle with typed ref surface (id, name, status).
   */
  pagesCustomDomain(
    id: string,
    spec: PagesCustomDomainSpec,
    options?: ResourceOptions,
  ): ResourceHandle<PagesCustomDomainSpec, PagesCustomDomainRefs>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class CloudflareProviderHandleImpl implements CloudflareProviderHandle {
  constructor(
    readonly instanceKey: string,
    readonly adapterName: string,
    private readonly registerResource: ResourceRegistrar,
  ) {}

  dnsRecord(
    id: string,
    spec: DnsRecordSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DnsRecordSpec, DnsRecordRefs> {
    return this.typedResource(
      "DnsRecord",
      id,
      spec,
      options,
      buildDnsRecordRefs,
    );
  }

  accessApplication(
    id: string,
    spec: AccessApplicationSpec,
    options?: ResourceOptions,
  ): ResourceHandle<AccessApplicationSpec, AccessApplicationRefs> {
    return this.typedResource(
      "AccessApplication",
      id,
      spec,
      options,
      buildAccessApplicationRefs,
    );
  }

  accessPolicy(
    id: string,
    spec: AccessPolicySpec,
    options?: ResourceOptions,
  ): ResourceHandle<AccessPolicySpec, AccessPolicyRefs> {
    return this.typedResource(
      "AccessPolicy",
      id,
      spec,
      options,
      buildAccessPolicyRefs,
    );
  }

  identityProvider(
    id: string,
    spec: IdentityProviderSpec,
    options?: ResourceOptions,
  ): ResourceHandle<IdentityProviderSpec, IdentityProviderRefs> {
    return this.typedResource(
      "IdentityProvider",
      id,
      spec,
      options,
      buildIdentityProviderRefs,
    );
  }

  pagesCustomDomain(
    id: string,
    spec: PagesCustomDomainSpec,
    options?: ResourceOptions,
  ): ResourceHandle<PagesCustomDomainSpec, PagesCustomDomainRefs> {
    return this.typedResource(
      "PagesCustomDomain",
      id,
      spec,
      options,
      buildPagesCustomDomainRefs,
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
 * Create a typed Cloudflare provider handle.
 *
 * Takes the provider instance key, adapter name, and a registration
 * function. The registration function is obtained from the base
 * `ProviderHandle` — it's the callback that registers resources with
 * the authoring scope.
 *
 * Usage:
 *
 * ```typescript
 * import { cloudflare, createCloudflareHandle } from "infrasync";
 *
 * const infra = defineInfra("prod", (infra) => {
 *   const baseCf = infra.provider("cf", cloudflare, { ... });
 *   const cf = createCloudflareHandle(
 *     baseCf.instanceKey,
 *     baseCf.adapterName,
 *     baseCf.register,
 *   );
 *
 *   const record = cf.dnsRecord("www", {
 *     kind: "DnsRecord",
 *     domain: "www.example.com",
 *     type: "CNAME",
 *     value: "target.example.com",
 *   });
 * });
 * ```
 */
export function createCloudflareHandle(
  instanceKey: string,
  adapterName: string,
  registerResource: ResourceRegistrar,
): CloudflareProviderHandle {
  return new CloudflareProviderHandleImpl(
    instanceKey,
    adapterName,
    registerResource,
  );
}
