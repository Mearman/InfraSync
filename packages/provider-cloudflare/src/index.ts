import Cloudflare from "cloudflare";
import type {
  ProviderPort,
  ResourcePort,
  ProviderAdapter,
  ResolvedScopes,
} from "@infrasync/core/provider";
import { defineProvider } from "@infrasync/core/provider";
import * as z from "zod";
import { DnsRecordResource } from "./dns-record.js";
import { AccessApplicationResource } from "./access-app.js";
import { AccessPolicyResource } from "./access-policy.js";
import { IdentityProviderResource } from "./identity-provider.js";
import { PagesCustomDomainResource } from "./pages-domain.js";
import { AccessGroupResource } from "./access-group.js";
import { TunnelResource } from "./tunnel.js";

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

  private client: Cloudflare | undefined;

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
    return [
      "DnsRecord",
      "AccessApplication",
      "AccessPolicy",
      "IdentityProvider",
      "PagesCustomDomain",
      "AccessGroup",
      "Tunnel",
    ];
  }

  resourceHandler(kind: string, scopes: ResolvedScopes): ResourcePort {
    if (this.client === undefined) {
      throw new Error(
        "Cloudflare provider not connected — call connect() first",
      );
    }

    switch (kind) {
      case "DnsRecord":
        return new DnsRecordResource(this.client);
      case "AccessApplication":
        return new AccessApplicationResource(this.client, scopes);
      case "AccessPolicy":
        return new AccessPolicyResource(this.client, scopes);
      case "IdentityProvider":
        return new IdentityProviderResource(this.client, scopes);
      case "PagesCustomDomain":
        return new PagesCustomDomainResource(this.client, scopes);
      case "AccessGroup":
        return new AccessGroupResource(this.client, scopes);
      case "Tunnel":
        return new TunnelResource(this.client, scopes);
      default:
        throw new Error(`Cloudflare: unsupported resource kind "${kind}"`);
    }
  }
}
