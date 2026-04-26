import type {
  ProviderPort,
  ResourcePort,
  ProviderAdapter,
  ResolvedScopes,
} from "@infrasync/core/provider";
import { defineProvider } from "@infrasync/core/provider";
import * as z from "zod";
import { TailscaleClient } from "./client.js";
import { ACLPolicyResource } from "./acl-policy.js";
import { TailnetKeyResource } from "./tailnet-key.js";
import { DNSNameserversResource } from "./dns-nameservers.js";
import { DNSSearchPathsResource } from "./dns-search-paths.js";
import { DNSPreferencesResource } from "./dns-preferences.js";

// ─── Config schema ───────────────────────────────────────────────────────────

export const tailscaleConfigSchema = z.strictObject({
  apiKey: z.string().trim().min(1),
  tailnetId: z.string().trim().min(1),
  /** Optional base URL override (default: https://api.tailscale.com) */
  baseUrl: z.string().trim().min(1).optional(),
});

export type TailscaleConfig = z.infer<typeof tailscaleConfigSchema>;

// ─── Adapter descriptor ────────────────────────────────────────────────────

/**
 * The Tailscale adapter descriptor. Pass this to `infra.provider()`:
 *
 * ```typescript
 * import { tailscale } from "@infrasync/tailscale";
 *
 * const ts = infra.provider("ts", tailscale, {
 *   apiKey: infra.secret.env("TAILSCALE_API_KEY"),
 *   tailnetId: "your-tailnet-id",
 * });
 * ```
 */
export const tailscale: ProviderAdapter<typeof tailscaleConfigSchema> =
  defineProvider("tailscale", () => new TailscaleProvider());

export class TailscaleProvider implements ProviderPort<
  typeof tailscaleConfigSchema
> {
  readonly name = "tailscale";
  readonly configSchema = tailscaleConfigSchema;

  private client: TailscaleClient | undefined;

  async connect(config: unknown): Promise<void> {
    const result = tailscaleConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(
        `Tailscale config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      );
    }
    this.client = new TailscaleClient(result.data.apiKey, result.data.baseUrl);
    await Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.client = undefined;
    await Promise.resolve();
  }

  supportedKinds(): string[] {
    return [
      "ACLPolicy",
      "TailnetKey",
      "DNSNameservers",
      "DNSSearchPaths",
      "DNSPreferences",
    ];
  }

  resourceHandler(kind: string, scopes: ResolvedScopes): ResourcePort {
    if (this.client === undefined) {
      throw new Error(
        "Tailscale provider not connected — call connect() first",
      );
    }

    switch (kind) {
      case "ACLPolicy":
        return new ACLPolicyResource(this.client, scopes);
      case "TailnetKey":
        return new TailnetKeyResource(this.client, scopes);
      case "DNSNameservers":
        return new DNSNameserversResource(this.client, scopes);
      case "DNSSearchPaths":
        return new DNSSearchPathsResource(this.client, scopes);
      case "DNSPreferences":
        return new DNSPreferencesResource(this.client, scopes);
      default:
        throw new Error(`Tailscale: unsupported resource kind "${kind}"`);
    }
  }
}

// Re-export schemas and types for convenience
export { aclPolicySpecSchema, type ACLPolicySpec } from "./acl-policy.js";
export {
  tailnetKeySpecSchema,
  type TailnetKeySpec,
  buildTailnetKeyRefs,
  type TailnetKeyRefs,
} from "./tailnet-key.js";
export {
  dnsNameserversSpecSchema,
  type DNSNameserversSpec,
} from "./dns-nameservers.js";
export {
  dnsSearchPathsSpecSchema,
  type DNSSearchPathsSpec,
} from "./dns-search-paths.js";
export {
  dnsPreferencesSpecSchema,
  type DNSPreferencesSpec,
} from "./dns-preferences.js";
