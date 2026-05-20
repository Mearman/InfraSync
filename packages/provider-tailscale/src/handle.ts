import type {
  ResourceHandle,
  ResourceOptions,
  RefBuilder,
} from "@infrasync-org/core/handles";
import { createResourceHandle } from "@infrasync-org/core/handles";
import type { TailnetKeyRefs } from "./tailnet-key.js";
import { buildTailnetKeyRefs } from "./tailnet-key.js";
import type { ACLPolicySpec } from "./acl-policy.js";
import type { TailnetKeySpec } from "./tailnet-key.js";
import type { DNSNameserversSpec } from "./dns-nameservers.js";
import type { DNSSearchPathsSpec } from "./dns-search-paths.js";
import type { DNSPreferencesSpec } from "./dns-preferences.js";

// ─── Registration function ───────────────────────────────────────────────────

export type ResourceRegistrar = (
  handle: ResourceHandle<unknown, unknown>,
) => void;

// ─── Typed Tailscale handle ──────────────────────────────────────────────────

export interface TailscaleProviderHandle {
  readonly instanceKey: string;
  readonly adapterName: string;

  aclPolicy(
    id: string,
    spec: ACLPolicySpec,
    options?: ResourceOptions,
  ): ResourceHandle<ACLPolicySpec, Record<string, unknown>>;

  tailnetKey(
    id: string,
    spec: TailnetKeySpec,
    options?: ResourceOptions,
  ): ResourceHandle<TailnetKeySpec, TailnetKeyRefs>;

  dnsNameservers(
    id: string,
    spec: DNSNameserversSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DNSNameserversSpec, Record<string, unknown>>;

  dnsSearchPaths(
    id: string,
    spec: DNSSearchPathsSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DNSSearchPathsSpec, Record<string, unknown>>;

  dnsPreferences(
    id: string,
    spec: DNSPreferencesSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DNSPreferencesSpec, Record<string, unknown>>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class TailscaleProviderHandleImpl implements TailscaleProviderHandle {
  constructor(
    readonly instanceKey: string,
    readonly adapterName: string,
    private readonly registerResource: ResourceRegistrar,
  ) {}

  aclPolicy(
    id: string,
    spec: ACLPolicySpec,
    options?: ResourceOptions,
  ): ResourceHandle<ACLPolicySpec, Record<string, unknown>> {
    return this.typedResource("ACLPolicy", id, spec, options, () => ({}));
  }

  tailnetKey(
    id: string,
    spec: TailnetKeySpec,
    options?: ResourceOptions,
  ): ResourceHandle<TailnetKeySpec, TailnetKeyRefs> {
    return this.typedResource(
      "TailnetKey",
      id,
      spec,
      options,
      buildTailnetKeyRefs,
    );
  }

  dnsNameservers(
    id: string,
    spec: DNSNameserversSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DNSNameserversSpec, Record<string, unknown>> {
    return this.typedResource("DNSNameservers", id, spec, options, () => ({}));
  }

  dnsSearchPaths(
    id: string,
    spec: DNSSearchPathsSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DNSSearchPathsSpec, Record<string, unknown>> {
    return this.typedResource("DNSSearchPaths", id, spec, options, () => ({}));
  }

  dnsPreferences(
    id: string,
    spec: DNSPreferencesSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DNSPreferencesSpec, Record<string, unknown>> {
    return this.typedResource("DNSPreferences", id, spec, options, () => ({}));
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

export function createTailscaleHandle(
  instanceKey: string,
  adapterName: string,
  registerResource: ResourceRegistrar,
): TailscaleProviderHandle {
  return new TailscaleProviderHandleImpl(
    instanceKey,
    adapterName,
    registerResource,
  );
}
