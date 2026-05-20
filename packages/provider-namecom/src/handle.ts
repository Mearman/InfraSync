import type {
  ResourceHandle,
  ResourceOptions,
  RefBuilder,
} from "@infrasync-org/core/handles";
import { createResourceHandle } from "@infrasync-org/core/handles";
import type { DnsRecordRefs } from "./dns-record.js";
import { buildDnsRecordRefs } from "./dns-record.js";
import type { DomainRefs } from "./domain.js";
import { buildDomainRefs } from "./domain.js";
import type { DnsRecordSpec } from "./dns-record.js";
import type { DomainSpec } from "./domain.js";

// ─── Registration function ───────────────────────────────────────────────────

export type ResourceRegistrar = (
  handle: ResourceHandle<unknown, unknown>,
) => void;

// ─── Typed name.com handle ───────────────────────────────────────────────────

/**
 * A typed provider handle for name.com resources.
 *
 * Created by `createNamecomHandle()`. Each method returns a
 * `ResourceHandle` with the correct spec type and typed ref surface.
 */
export interface NamecomProviderHandle {
  readonly instanceKey: string;
  readonly adapterName: string;

  dnsRecord(
    id: string,
    spec: DnsRecordSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DnsRecordSpec, DnsRecordRefs>;

  domain(
    id: string,
    spec: DomainSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DomainSpec, DomainRefs>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class NamecomProviderHandleImpl implements NamecomProviderHandle {
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

  domain(
    id: string,
    spec: DomainSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DomainSpec, DomainRefs> {
    return this.typedResource("Domain", id, spec, options, buildDomainRefs);
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
 * Create a typed name.com provider handle.
 */
export function createNamecomHandle(
  instanceKey: string,
  adapterName: string,
  registerResource: ResourceRegistrar,
): NamecomProviderHandle {
  return new NamecomProviderHandleImpl(
    instanceKey,
    adapterName,
    registerResource,
  );
}
