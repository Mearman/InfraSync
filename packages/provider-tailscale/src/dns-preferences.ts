import type {
  ResourcePort,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync/core/provider";
import { TailscaleClient, requireClient } from "./client.js";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const dnsPreferencesSpecSchema = z.object({
  kind: z.literal("DNSPreferences"),
  magicDNS: z.boolean(),
});

export type DNSPreferencesSpec = z.infer<typeof dnsPreferencesSpecSchema>;

const dnsPreferencesStateSchema = z
  .looseObject({
    magicDNS: z.boolean(),
  })
  .brand<"TailscaleDnsPreferencesState">()
  .readonly();

const identitySchema = dnsPreferencesSpecSchema.pick({ kind: true });
const desiredStateSchema = dnsPreferencesSpecSchema.pick({ magicDNS: true });

// ─── Resource implementation ─────────────────────────────────────────────────

export class DNSPreferencesResource implements ResourcePort<
  typeof dnsPreferencesSpecSchema,
  typeof dnsPreferencesStateSchema
> {
  readonly kind = "DNSPreferences";
  readonly specSchema = dnsPreferencesSpecSchema;
  readonly stateSchema = dnsPreferencesStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  readonly scopes: ResourceScopes = {
    tailnetId: { config: "tailnetId" },
  };

  constructor(
    private readonly client: TailscaleClient | undefined,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId(state: unknown): string {
    void state;
    return "dns-preferences";
  }

  async read(): Promise<unknown> {
    const tailnet = this.resolvedScopes.get("tailnetId");
    return requireClient(this.client).getDnsPreferences(tailnet);
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = dnsPreferencesSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("tailscale", "create", parsed.error.issues);
    }
    const tailnet = this.resolvedScopes.get("tailnetId");
    return requireClient(this.client).setDnsPreferences(tailnet, {
      magicDNS: parsed.data.magicDNS,
    });
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    // Singleton resource — id is the fixed state ID, not used by the API
    void id;
    return this.create(spec);
  }
}
