import type {
  ResourcePort,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync/core/provider";
import { TailscaleClient, requireClient } from "./client.js";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const dnsSearchPathsSpecSchema = z.object({
  kind: z.literal("DNSSearchPaths"),
  searchPaths: z.array(z.string().trim().min(1)).min(1),
});

export type DNSSearchPathsSpec = z.infer<typeof dnsSearchPathsSpecSchema>;

const dnsSearchPathsStateSchema = z
  .looseObject({
    searchPaths: z.array(z.string().trim()).readonly(),
  })
  .brand<"TailscaleDnsSearchPathsState">()
  .readonly();

const identitySchema = dnsSearchPathsSpecSchema.pick({ kind: true });
const desiredStateSchema = dnsSearchPathsSpecSchema.pick({
  searchPaths: true,
});

// ─── API response schema ─────────────────────────────────────────────────────

const apiResponseSchema = z.looseObject({
  searchPaths: z.array(z.string().trim()),
});

// ─── Resource implementation ─────────────────────────────────────────────────

export class DNSSearchPathsResource implements ResourcePort<
  typeof dnsSearchPathsSpecSchema,
  typeof dnsSearchPathsStateSchema
> {
  readonly kind = "DNSSearchPaths";
  readonly specSchema = dnsSearchPathsSpecSchema;
  readonly stateSchema = dnsSearchPathsStateSchema;
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
    if (typeof state === "object" && state !== null && "searchPaths" in state) {
      return "dns-search-paths";
    }
    throw new Error("Invalid state: missing searchPaths");
  }

  async read(): Promise<unknown> {
    const tailnet = this.resolvedScopes.get("tailnetId");
    const raw = await requireClient(this.client).getDnsSearchPaths(tailnet);
    const result = apiResponseSchema.safeParse(raw);
    if (!result.success) return undefined;
    if (result.data.searchPaths.length === 0) return undefined;
    return { searchPaths: result.data.searchPaths };
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = dnsSearchPathsSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("tailscale", "create", parsed.error.issues);
    }
    const tailnet = this.resolvedScopes.get("tailnetId");
    const raw = await requireClient(this.client).setDnsSearchPaths(
      tailnet,
      parsed.data.searchPaths,
    );
    const result = apiResponseSchema.parse(raw);
    return { searchPaths: result.searchPaths };
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    // Singleton resource — id is the fixed state ID, not used by the API
    void id;
    return this.create(spec);
  }
}
