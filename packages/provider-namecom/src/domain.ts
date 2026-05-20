import { NamecomClient } from "./client.js";
import type { ResourcePort, ResourceCodec } from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface DomainRefs {
  readonly id: RefToken;
  readonly domainName: RefToken;
}

export const buildDomainRefs: RefBuilder<DomainRefs> = (resourceName) => ({
  id: new RefToken(resourceName, "domainName"),
  domainName: new RefToken(resourceName, "domainName"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const domainSpecSchema = z.object({
  kind: z.literal("Domain"),
  /** The domain name */
  domainName: z.string().trim().min(1),
  /** Nameservers for the domain */
  nameservers: z.array(z.string().trim().min(1)).optional(),
  /** Whether autorenew is enabled */
  autorenewEnabled: z.boolean().optional(),
  /** Whether the domain is locked against transfers */
  locked: z.boolean().optional(),
});

export type DomainSpec = z.infer<typeof domainSpecSchema>;

const domainStateSchema = z
  .looseObject({
    domainName: z.string().trim(),
    nameservers: z.array(z.string().trim()).optional(),
    privacyEnabled: z.boolean().optional(),
    locked: z.boolean().optional(),
    autorenewEnabled: z.boolean().optional(),
    expireDate: z.string().trim().optional(),
    createDate: z.string().trim().optional(),
    renewalPrice: z.coerce.number().optional(),
  })
  .brand<"NamecomDomainState">()
  .readonly();

const identitySchema = domainSpecSchema.pick({
  domainName: true,
});

const desiredStateSchema = domainSpecSchema.pick({
  nameservers: true,
  autorenewEnabled: true,
  locked: true,
});

// ─── Codec schemas ───────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("Domain"),
  domainName: z.string().trim().min(1),
  nameservers: z.array(z.string().trim().min(1)).optional(),
  autorenewEnabled: z.boolean().optional(),
  locked: z.boolean().optional(),
});

const DOMAIN_KIND = "Domain" as const;

const codecOutputSchema = z.looseObject({
  domainName: z.string().trim().optional(),
  nameservers: z.array(z.string().trim()).optional(),
  locked: z.boolean().optional(),
  autorenewEnabled: z.boolean().optional(),
});

const domainZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    domainName: spec.domainName,
    nameservers: spec.nameservers,
    locked: spec.locked,
    autorenewEnabled: spec.autorenewEnabled,
  }),
  encode: (state) => ({
    kind: DOMAIN_KIND,
    domainName: state.domainName ?? "",
    nameservers: state.nameservers,
    locked: state.locked,
    autorenewEnabled: state.autorenewEnabled,
  }),
});

const namecomDomainCodec: ResourceCodec = {
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
  readonly codec = namecomDomainCodec;

  constructor(private readonly client: NamecomClient) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "domainName" in state) {
      if (typeof state.domainName === "string") return state.domainName;
    }
    throw new ProviderApiError("namecom", "getStateId", [
      {
        path: ["domainName"],
        message: "State object does not contain a valid 'domainName' field",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = domainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecom", "read", parsed.error.issues);
    }
    const { domainName } = parsed.data;

    try {
      return await this.client.getDomain(domainName);
    } catch {
      return undefined;
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = domainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecom", "create", parsed.error.issues);
    }
    const { domainName } = parsed.data;

    // Domains must be purchased through the name.com API separately.
    // Here we just verify the domain exists and return its current state.
    try {
      return await this.client.getDomain(domainName);
    } catch {
      throw new ProviderApiError("namecom", "create", [
        {
          path: ["domainName"],
          message: `Domain "${domainName}" not found in account — domains must be purchased through name.com first`,
        },
      ]);
    }
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = domainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecom", "update", parsed.error.issues);
    }
    const { nameservers, autorenewEnabled, locked } = parsed.data;

    // Set nameservers if specified
    if (nameservers !== undefined) {
      await this.client.setNameservers(id, nameservers);
    }

    // Toggle autorenew
    if (autorenewEnabled === true) {
      await this.client.enableAutorenew(id);
    } else if (autorenewEnabled === false) {
      await this.client.disableAutorenew(id);
    }

    // Toggle lock
    if (locked === true) {
      await this.client.lockDomain(id);
    } else if (locked === false) {
      await this.client.unlockDomain(id);
    }

    // Return the updated domain state
    return await this.client.getDomain(id);
  }
}
