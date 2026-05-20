import { NamecomClient, requireClient } from "./client.js";
import type {
  ProviderPort,
  ResourcePort,
  ProviderAdapter,
  ResolvedScopes,
  ResourceRegistry,
} from "@infrasync-org/core/provider";
import {
  defineProvider,
  ResourceRegistry as Registry,
} from "@infrasync-org/core/provider";
import * as z from "zod";
import { DnsRecordResource } from "./dns-record.js";
import { DomainResource } from "./domain.js";

// ─── Config schema ───────────────────────────────────────────────────────────

export const namecomConfigSchema = z.strictObject({
  username: z.string().trim().min(1),
  apiToken: z.string().trim().min(1),
  /** Optional base URL override (default: https://api.name.com) */
  baseUrl: z.string().trim().min(1).optional(),
});

export type NamecomConfig = z.infer<typeof namecomConfigSchema>;

// ─── Adapter descriptor ────────────────────────────────────────────────────

/**
 * The name.com adapter descriptor. Pass this to `infra.provider()`:
 *
 * ```typescript
 * import { namecom } from "@infrasync-org/namecom";
 *
 * const nc = infra.provider("nc", namecom, {
 *   username: infra.secret.env("NAMECOM_USERNAME"),
 *   apiToken: infra.secret.env("NAMECOM_API_TOKEN"),
 * });
 * ```
 */
export const namecom: ProviderAdapter<typeof namecomConfigSchema> =
  defineProvider("namecom", () => new NamecomProvider());

export class NamecomProvider implements ProviderPort<
  typeof namecomConfigSchema
> {
  readonly name = "namecom";
  readonly configSchema = namecomConfigSchema;

  /** Pluggable resource registry for extending name.com resources. */
  readonly registry: ResourceRegistry = new Registry();

  private client: NamecomClient | undefined;

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
   * Returns the connected name.com client, or throws if not connected.
   */
  connectedClient(): NamecomClient {
    return requireClient(this.client);
  }

  async connect(config: unknown): Promise<void> {
    const result = namecomConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(
        `name.com config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      );
    }
    this.client = new NamecomClient(
      result.data.username,
      result.data.apiToken,
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
