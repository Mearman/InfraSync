import Cloudflare from "cloudflare";
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
import { AccessApplicationResource } from "./access-app.js";
import { AccessPolicyResource } from "./access-policy.js";
import { IdentityProviderResource } from "./identity-provider.js";
import { PagesCustomDomainResource } from "./pages-domain.js";
import { AccessGroupResource } from "./access-group.js";
import { TunnelResource } from "./tunnel.js";
import { ZoneResource } from "./zone.js";
import { R2BucketResource } from "./r2-bucket.js";
import { WorkerRouteResource } from "./worker-route.js";
import { PagesProjectResource } from "./pages-project.js";
import { EmailRoutingRuleResource } from "./email-routing-rule.js";

// ─── Config schema ───────────────────────────────────────────────────────────

export const cloudflareConfigSchema = z.strictObject({
  apiToken: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
});

export type CloudflareConfig = z.infer<typeof cloudflareConfigSchema>;

// ─── Adapter descriptor ────────────────────────────────────────────────────

/**
 * The Cloudflare adapter descriptor. Pass this to `infra.provider()`:
 *
 * ```typescript
 * import { cloudflare } from "infrasync/providers/cloudflare";
 *
 * const cf = infra.provider("cf", cloudflare, {
 *   apiToken: infra.secret.env("CLOUDFLARE_API_TOKEN"),
 *   accountId: "your-account-id",
 * });
 * ```
 */
export const cloudflare: ProviderAdapter<typeof cloudflareConfigSchema> =
  defineProvider("cloudflare", () => new CloudflareProvider());

export class CloudflareProvider implements ProviderPort<
  typeof cloudflareConfigSchema
> {
  readonly name = "cloudflare";
  readonly configSchema = cloudflareConfigSchema;

  /**
   * Pluggable resource registry. Users can register additional resource kinds
   * after the provider is created:
   *
   * ```typescript
   * const provider = new CloudflareProvider();
   * provider.registry.register("MyResource", (scopes) => {
   *   return new MyResource(provider.connectedClient(), scopes);
   * });
   * ```
   */
  readonly registry: ResourceRegistry = new Registry();

  private client: Cloudflare | undefined;

  constructor() {
    // Built-in resources — each factory calls connectedClient() to get the
    // narrowed Cloudflare instance. No type assertions needed.
    this.registry.register("DnsRecord", () => {
      const client = this.connectedClient();
      return new DnsRecordResource(client);
    });

    this.registry.register("AccessApplication", (scopes) => {
      const client = this.connectedClient();
      return new AccessApplicationResource(client, scopes);
    });

    this.registry.register("AccessPolicy", (scopes) => {
      const client = this.connectedClient();
      return new AccessPolicyResource(client, scopes);
    });

    this.registry.register("IdentityProvider", (scopes) => {
      const client = this.connectedClient();
      return new IdentityProviderResource(client, scopes);
    });

    this.registry.register("PagesCustomDomain", (scopes) => {
      const client = this.connectedClient();
      return new PagesCustomDomainResource(client, scopes);
    });

    this.registry.register("AccessGroup", (scopes) => {
      const client = this.connectedClient();
      return new AccessGroupResource(client, scopes);
    });

    this.registry.register("Tunnel", (scopes) => {
      const client = this.connectedClient();
      return new TunnelResource(client, scopes);
    });

    this.registry.register("Zone", (scopes) => {
      const client = this.connectedClient();
      return new ZoneResource(client, scopes);
    });

    this.registry.register("R2Bucket", (scopes) => {
      const client = this.connectedClient();
      return new R2BucketResource(client, scopes);
    });

    this.registry.register("WorkerRoute", (scopes) => {
      const client = this.connectedClient();
      return new WorkerRouteResource(client, scopes);
    });

    this.registry.register("PagesProject", (scopes) => {
      const client = this.connectedClient();
      return new PagesProjectResource(client, scopes);
    });

    this.registry.register("EmailRoutingRule", (scopes) => {
      const client = this.connectedClient();
      return new EmailRoutingRuleResource(client, scopes);
    });
  }

  /**
   * Returns the connected Cloudflare client, or throws if not connected.
   * Narrowing helper — avoids type assertions in registry closures.
   */
  connectedClient(): Cloudflare {
    if (this.client === undefined) {
      throw new Error(
        "Cloudflare provider not connected — call connect() first",
      );
    }
    return this.client;
  }

  async connect(config: unknown): Promise<void> {
    const result = cloudflareConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(
        `Cloudflare config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      );
    }
    this.client = new Cloudflare({ apiToken: result.data.apiToken });
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
