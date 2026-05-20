import { NamecheapClient, requireClient } from "./client.js";
import type {
  ProviderPort,
  ResourcePort,
  ProviderAdapter,
  ResolvedScopes,
  ResourceRegistry,
} from "@infrasync/core/provider";
import {
  defineProvider,
  ResourceRegistry as Registry,
} from "@infrasync/core/provider";
import * as z from "zod";
import { DnsRecordResource } from "./dns-record.js";
import { DomainResource } from "./domain.js";

// ─── Config schema ───────────────────────────────────────────────────────────

export const namecheapConfigSchema = z.strictObject({
  apiUser: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  userName: z.string().trim().min(1),
  clientIp: z.string().trim().min(1),
  /** Optional base URL override (default: https://api.namecheap.com/xml.response) */
  baseUrl: z.string().trim().min(1).optional(),
});

export type NamecheapConfig = z.infer<typeof namecheapConfigSchema>;

// ─── Adapter descriptor ────────────────────────────────────────────────────

/**
 * The Namecheap adapter descriptor. Pass this to `infra.provider()`:
 *
 * ```typescript
 * import { namecheap } from "@infrasync/namecheap";
 *
 * const nc = infra.provider("nc", namecheap, {
 *   apiUser: infra.secret.env("NAMECHEAP_API_USER"),
 *   apiKey: infra.secret.env("NAMECHEAP_API_KEY"),
 *   userName: infra.secret.env("NAMECHEAP_USERNAME"),
 *   clientIp: infra.secret.env("NAMECHEAP_CLIENT_IP"),
 * });
 * ```
 */
export const namecheap: ProviderAdapter<typeof namecheapConfigSchema> =
  defineProvider("namecheap", () => new NamecheapProvider());

export class NamecheapProvider implements ProviderPort<
  typeof namecheapConfigSchema
> {
  readonly name = "namecheap";
  readonly configSchema = namecheapConfigSchema;

  /** Pluggable resource registry for extending Namecheap resources. */
  readonly registry: ResourceRegistry = new Registry();

  private client: NamecheapClient | undefined;

  constructor() {
    this.registry.register("DnsRecord", () => {
      const client = requireClient(this.client);
      return new DnsRecordResource(client);
    });

    this.registry.register("Domain", () => {
      const client = requireClient(this.client);
      return new DomainResource(client);
    });
  }

  /**
   * Returns the connected Namecheap client, or throws if not connected.
   */
  connectedClient(): NamecheapClient {
    return requireClient(this.client);
  }

  async connect(config: unknown): Promise<void> {
    const result = namecheapConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(
        `Namecheap config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      );
    }
    this.client = new NamecheapClient(
      result.data.apiUser,
      result.data.apiKey,
      result.data.userName,
      result.data.clientIp,
      result.data.baseUrl,
    );
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

// Re-export schemas and types for convenience
export {
  dnsRecordSpecSchema,
  type DnsRecordSpec,
  buildDnsRecordRefs,
  type DnsRecordRefs,
} from "./dns-record.js";
export {
  domainSpecSchema,
  type DomainSpec,
  buildDomainRefs,
  type DomainRefs,
} from "./domain.js";
