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
 * import { tailscale } from "@infrasync-org/tailscale";
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

  /** Pluggable resource registry for extending Tailscale resources. */
  readonly registry: ResourceRegistry = new Registry();

  private client: TailscaleClient | undefined;

  constructor() {
    // Each factory closes over `this`. The client may be undefined until
    // connect() is called — resources validate client presence at operation
    // time, not at handler construction time.
    this.registry.register(
      "ACLPolicy",
      (scopes) => new ACLPolicyResource(this.client, scopes),
    );

    this.registry.register(
      "TailnetKey",
      (scopes) => new TailnetKeyResource(this.client, scopes),
    );

    this.registry.register(
      "DNSNameservers",
      (scopes) => new DNSNameserversResource(this.client, scopes),
    );

    this.registry.register(
      "DNSSearchPaths",
      (scopes) => new DNSSearchPathsResource(this.client, scopes),
    );

    this.registry.register(
      "DNSPreferences",
      (scopes) => new DNSPreferencesResource(this.client, scopes),
    );
  }

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
    return this.registry.kinds();
  }

  resourceHandler(kind: string, scopes: ResolvedScopes): ResourcePort {
    return this.registry.create(kind, scopes);
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
