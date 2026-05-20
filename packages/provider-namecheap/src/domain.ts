import { NamecheapClient } from "./client.js";
import type { ResourcePort, ResourceCodec } from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync-org/core/errors";

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
  /** Custom nameservers for the domain */
  nameservers: z.array(z.string().trim().min(1)).optional(),
});

export type DomainSpec = z.infer<typeof domainSpecSchema>;

const domainStateSchema = z
  .looseObject({
    domainName: z.string().trim(),
    nameservers: z.array(z.string().trim()).optional(),
  })
  .brand<"NamecheapDomainState">()
  .readonly();

const identitySchema = domainSpecSchema.pick({
  domainName: true,
});

const desiredStateSchema = domainSpecSchema.pick({
  nameservers: true,
});

// ─── Codec ───────────────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("Domain"),
  domainName: z.string().trim().min(1),
  nameservers: z.array(z.string().trim().min(1)).optional(),
});

const DOMAIN_KIND = "Domain" as const;

const codecOutputSchema = z.looseObject({
  domainName: z.string().trim().optional(),
  nameservers: z.array(z.string().trim()).optional(),
});

const domainZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    domainName: spec.domainName,
    nameservers: spec.nameservers,
  }),
  encode: (state) => ({
    kind: DOMAIN_KIND,
    domainName: state.domainName ?? "",
    nameservers: state.nameservers,
  }),
});

const namecheapDomainCodec: ResourceCodec = {
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
  readonly codec = namecheapDomainCodec;

  constructor(private readonly client: NamecheapClient) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "domainName" in state) {
      if (typeof state.domainName === "string") return state.domainName;
    }
    throw new ProviderApiError("namecheap", "getStateId", [
      {
        path: ["domainName"],
        message: "State object does not contain a valid 'domainName' field",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = domainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecheap", "read", parsed.error.issues);
    }
    const { domainName } = parsed.data;

    try {
      const nameservers = await this.client.getNameservers(
        ...splitDomain(domainName),
      );
      return { domainName, nameservers };
    } catch {
      return undefined;
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = domainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecheap", "create", parsed.error.issues);
    }
    const { domainName } = parsed.data;

    // Domains must be purchased through Namecheap separately.
    // Here we just verify the domain exists and return its current state.
    try {
      const nameservers = await this.client.getNameservers(
        ...splitDomain(domainName),
      );
      return { domainName, nameservers };
    } catch {
      throw new ProviderApiError("namecheap", "create", [
        {
          path: ["domainName"],
          message: `Domain "${domainName}" not found in account — domains must be purchased through Namecheap first`,
        },
      ]);
    }
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = domainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecheap", "update", parsed.error.issues);
    }
    const { nameservers } = parsed.data;

    // Set custom nameservers if specified
    if (nameservers !== undefined) {
      const [sld, tld] = splitDomain(id);
      await this.client.setCustomNameservers(sld, tld, nameservers);
    }

    // Return the updated domain state
    const currentNs = await this.client.getNameservers(...splitDomain(id));
    return { domainName: id, nameservers: [...currentNs] };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function splitDomain(domain: string): [sld: string, tld: string] {
  const multiPartTlds = [
    "co.uk",
    "org.uk",
    "me.uk",
    "co.nz",
    "net.nz",
    "org.nz",
    "com.au",
    "net.au",
    "org.au",
    "com.br",
    "net.br",
    "org.br",
    "co.jp",
    "or.jp",
    "ne.jp",
    "co.in",
    "net.in",
    "org.in",
    "com.sg",
    "com.hk",
    "com.tw",
    "com.tr",
    "com.mx",
    "org.mx",
    "com.ar",
    "co.za",
    "org.za",
    "co.ke",
    "co.il",
    "com.my",
    "com.ph",
  ];

  const lower = domain.toLowerCase();
  for (const tld of multiPartTlds) {
    if (lower.endsWith(`.${tld}`)) {
      const sld = lower.slice(0, -(tld.length + 1));
      return [sld, tld];
    }
  }

  const lastDot = lower.lastIndexOf(".");
  if (lastDot === -1) {
    return [lower, ""];
  }
  return [lower.slice(0, lastDot), lower.slice(lastDot + 1)];
}
