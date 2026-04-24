import Cloudflare from "cloudflare";
import type { ProviderPort, ResourcePort } from "../../core/provider.js";
import { z } from "zod";
import { DnsRecordResource } from "./dns-record.js";
import { AccessApplicationResource } from "./access-app.js";
import { AccessPolicyResource } from "./access-policy.js";
import { IdentityProviderResource } from "./identity-provider.js";
import { PagesCustomDomainResource } from "./pages-domain.js";

// ─── Config schema ───────────────────────────────────────────────────────────

export const cloudflareConfigSchema = z.strictObject({
  apiToken: z.string().min(1),
  accountId: z.string().min(1),
});

export type CloudflareConfig = z.infer<typeof cloudflareConfigSchema>;

// ─── Cloudflare provider ─────────────────────────────────────────────────────

export class CloudflareProvider implements ProviderPort<
  typeof cloudflareConfigSchema
> {
  readonly name = "cloudflare";
  readonly configSchema = cloudflareConfigSchema;

  private client: Cloudflare | undefined;
  private accountId: string | undefined;

  async connect(config: unknown): Promise<void> {
    const result = cloudflareConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(
        `Cloudflare config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      );
    }
    this.client = new Cloudflare({ apiToken: result.data.apiToken });
    this.accountId = result.data.accountId;
    await Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.client = undefined;
    this.accountId = undefined;
    await Promise.resolve();
  }

  supportedKinds(): string[] {
    return [
      "DnsRecord",
      "AccessApplication",
      "AccessPolicy",
      "IdentityProvider",
      "PagesCustomDomain",
    ];
  }

  resourceHandler(kind: string): ResourcePort {
    if (this.client === undefined) {
      throw new Error(
        "Cloudflare provider not connected — call connect() first",
      );
    }
    if (this.accountId === undefined) {
      throw new Error("Cloudflare provider not connected — accountId not set");
    }

    switch (kind) {
      case "DnsRecord":
        return new DnsRecordResource(this.client);
      case "AccessApplication":
        return new AccessApplicationResource(this.client, this.accountId);
      case "AccessPolicy":
        return new AccessPolicyResource(this.client, this.accountId);
      case "IdentityProvider":
        return new IdentityProviderResource(this.client, this.accountId);
      case "PagesCustomDomain":
        return new PagesCustomDomainResource(this.client, this.accountId);
      default:
        throw new Error(`Cloudflare: unsupported resource kind "${kind}"`);
    }
  }
}
