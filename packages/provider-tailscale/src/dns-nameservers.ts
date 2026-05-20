import type {
  ResourcePort,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync-org/core/provider";
import { TailscaleClient, requireClient } from "./client.js";
import * as z from "zod";
import { ProviderApiError } from "@infrasync-org/core/errors";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const dnsNameserversSpecSchema = z.object({
  kind: z.literal("DNSNameservers"),
  nameservers: z.array(z.string().trim().min(1)).min(1),
});

export type DNSNameserversSpec = z.infer<typeof dnsNameserversSpecSchema>;

const dnsNameserversStateSchema = z
  .looseObject({
    nameservers: z.array(z.string().trim()).readonly(),
  })
  .brand<"TailscaleDnsNameserversState">()
  .readonly();

const identitySchema = dnsNameserversSpecSchema.pick({ kind: true });
const desiredStateSchema = dnsNameserversSpecSchema.pick({
  nameservers: true,
});

// ─── API response schema ─────────────────────────────────────────────────────

const apiResponseSchema = z.looseObject({
  nameservers: z.array(z.string().trim()),
});

// ─── Resource implementation ─────────────────────────────────────────────────

export class DNSNameserversResource implements ResourcePort<
  typeof dnsNameserversSpecSchema,
  typeof dnsNameserversStateSchema
> {
  readonly kind = "DNSNameservers";
  readonly specSchema = dnsNameserversSpecSchema;
  readonly stateSchema = dnsNameserversStateSchema;
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
    if (typeof state === "object" && state !== null && "nameservers" in state) {
      return "dns-nameservers";
    }
    throw new Error("Invalid state: missing nameservers");
  }

  async read(): Promise<unknown> {
    const tailnet = this.resolvedScopes.get("tailnetId");
    const raw = await requireClient(this.client).getDnsNameservers(tailnet);
    const result = apiResponseSchema.safeParse(raw);
    if (!result.success) return undefined;
    if (result.data.nameservers.length === 0) return undefined;
    return { nameservers: result.data.nameservers };
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = dnsNameserversSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("tailscale", "create", parsed.error.issues);
    }
    const tailnet = this.resolvedScopes.get("tailnetId");
    const raw = await requireClient(this.client).setDnsNameservers(
      tailnet,
      parsed.data.nameservers,
    );
    const result = apiResponseSchema.parse(raw);
    return { nameservers: result.nameservers };
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    // Singleton resource — id is the fixed state ID, not used by the API
    void id;
    return this.create(spec);
  }
}
