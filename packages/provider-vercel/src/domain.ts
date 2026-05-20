import { Vercel } from "@vercel/sdk";
import type { ResourcePort, ResourceCodec } from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface DomainRefs {
  readonly id: RefToken;
  readonly name: RefToken;
}

export const buildDomainRefs: RefBuilder<DomainRefs> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const domainSpecSchema = z.object({
  kind: z.literal("Domain"),
  /** The domain name to add to the Vercel platform */
  name: z.string().trim().min(1),
});

export type DomainSpec = z.infer<typeof domainSpecSchema>;

const domainStateSchema = z
  .looseObject({
    id: z.string().trim().optional(),
    name: z.string().trim(),
    apexName: z.string().trim().optional(),
    verified: z.boolean().optional(),
    verification: z
      .array(
        z.looseObject({
          domain: z.string().trim().optional(),
          value: z.string().trim().optional(),
          reason: z.string().trim().optional(),
        }),
      )
      .optional(),
  })
  .brand<"VercelDomainState">()
  .readonly();

const identitySchema = domainSpecSchema.pick({
  name: true,
});

const desiredStateSchema = domainSpecSchema.pick({
  name: true,
});

// ─── Codec schemas ───────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("Domain"),
  name: z.string().trim().min(1),
});

const DOMAIN_KIND = "Domain" as const;

const codecOutputSchema = z.looseObject({
  id: z.string().trim().optional(),
  name: z.string().trim().optional(),
  apexName: z.string().trim().optional(),
  verified: z.boolean().optional(),
});

const domainZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.name,
  }),
  encode: (state) => ({
    kind: DOMAIN_KIND,
    name: state.name ?? "",
  }),
});

const vercelDomainCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return domainZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return domainZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class DomainResource implements ResourcePort<
  typeof domainSpecSchema,
  typeof domainStateSchema
> {
  readonly kind = "Domain";
  readonly specSchema = domainSpecSchema;
  readonly stateSchema = domainStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = vercelDomainCodec;

  constructor(private readonly client: Vercel) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null) {
      if ("id" in state && typeof state.id === "string") return state.id;
      if ("name" in state && typeof state.name === "string") return state.name;
    }
    throw new ProviderApiError("vercel", "getStateId", [
      {
        path: ["id"],
        message: "State object does not contain a valid 'id' or 'name' field",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = domainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "read", parsed.error.issues);
    }
    const { name } = parsed.data;

    try {
      const response = await this.client.domains.getDomain({
        domain: name,
      });
      return response;
    } catch {
      return undefined;
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = domainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "create", parsed.error.issues);
    }
    const { name } = parsed.data;

    const response = await this.client.domains.createOrTransferDomain({
      requestBody: {
        name,
      },
    });

    return response;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = domainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "update", parsed.error.issues);
    }

    void spec;

    // Domains don't have updatable fields beyond the name itself.
    // Use patchDomain to confirm the domain is still present.
    const response = await this.client.domains.patchDomain({
      domain: id,
      requestBody: {},
    });

    return response;
  }
}
