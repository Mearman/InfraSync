import { NamecheapClient } from "./client.js";
import type { ResourcePort, ResourceCodec } from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync-org/core/errors";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface DnsRecordRefs {
  readonly id: RefToken;
  readonly host: RefToken;
  readonly fqdn: RefToken;
  readonly type: RefToken;
  readonly answer: RefToken;
}

export const buildDnsRecordRefs: RefBuilder<DnsRecordRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  host: new RefToken(resourceName, "host"),
  fqdn: new RefToken(resourceName, "fqdn"),
  type: new RefToken(resourceName, "type"),
  answer: new RefToken(resourceName, "answer"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

const dnsRecordTypeSchema = z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]);

export const dnsRecordSpecSchema = z.object({
  kind: z.literal("DnsRecord"),
  /** Full domain name (e.g. "example.com") */
  domain: z.string().trim().min(1),
  /** Hostname relative to the zone ("@" for apex, "www" for subdomain) */
  host: z.string().trim(),
  /** Record type */
  type: dnsRecordTypeSchema,
  /** Record value (IP, target, text) */
  value: z.string().trim().min(1),
  /** TTL in seconds */
  ttl: z.int().min(60),
  /** Priority (MX only) */
  priority: z.int().min(0).optional(),
});

export type DnsRecordSpec = z.infer<typeof dnsRecordSpecSchema>;

const dnsRecordStateSchema = z
  .looseObject({
    hostId: z.coerce.number(),
    name: z.string().trim(),
    type: z.string().trim(),
    address: z.string().trim(),
    mxPref: z.coerce.number(),
    ttl: z.coerce.number(),
  })
  .brand<"NamecheapDnsRecordState">()
  .readonly();

const identitySchema = dnsRecordSpecSchema.pick({
  domain: true,
  host: true,
  type: true,
  value: true,
});

const desiredStateSchema = dnsRecordSpecSchema.pick({
  host: true,
  type: true,
  value: true,
  ttl: true,
  priority: true,
});

// ─── Codec ───────────────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("DnsRecord"),
  domain: z.string().trim().min(1),
  host: z.string().trim(),
  type: dnsRecordTypeSchema,
  value: z.string().trim().min(1),
  ttl: z.int().min(60),
  priority: z.int().min(0).optional(),
});

const DNS_RECORD_KIND = "DnsRecord" as const;

const codecOutputSchema = z.looseObject({
  hostId: z.coerce.number().optional(),
  name: z.string().trim().optional(),
  type: z.string().trim().optional(),
  address: z.string().trim().optional(),
  mxPref: z.coerce.number().optional(),
  ttl: z.coerce.number().optional(),
});

const dnsRecordZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.host,
    type: spec.type,
    address: spec.value,
    ttl: spec.ttl,
    mxPref: spec.priority ?? 0,
  }),
  encode: (state) => ({
    kind: DNS_RECORD_KIND,
    domain: "",
    host: state.name ?? "",
    type: dnsRecordTypeSchema.parse(state.type ?? "A"),
    value: state.address ?? "",
    ttl: Number(state.ttl),
    priority: state.mxPref !== undefined ? Number(state.mxPref) : undefined,
  }),
});

const namecheapDnsCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return dnsRecordZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return dnsRecordZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class DnsRecordResource implements ResourcePort<
  typeof dnsRecordSpecSchema,
  typeof dnsRecordStateSchema
> {
  readonly kind = "DnsRecord";
  readonly specSchema = dnsRecordSpecSchema;
  readonly stateSchema = dnsRecordStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = namecheapDnsCodec;

  constructor(private readonly client: NamecheapClient) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "hostId" in state) {
      if (typeof state.hostId === "number") return String(state.hostId);
    }
    throw new ProviderApiError("namecheap", "getStateId", [
      {
        path: ["hostId"],
        message: "State object does not contain a valid 'hostId' field",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = dnsRecordSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecheap", "read", parsed.error.issues);
    }
    const { domain, host, type, value } = parsed.data;

    const { sld, tld } = splitDomainForNamecheap(domain);
    const records = await this.client.getHosts(sld, tld);

    // Find matching record by host, type, and value
    const match = records.find(
      (r) => r.name === host && r.type === type && r.address === value,
    );

    return match;
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = dnsRecordSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecheap", "create", parsed.error.issues);
    }
    const { domain, host, type, value, ttl, priority } = parsed.data;

    const { sld, tld } = splitDomainForNamecheap(domain);

    // Read-modify-write: get all current records, append new one, set all back
    const existing = await this.client.getHosts(sld, tld);
    const allRecords = [
      ...existing.map(mapRecordToSetRecord),
      {
        hostName: host,
        recordType: type,
        address: value,
        mxPref: priority ?? 0,
        ttl,
      },
    ];

    await this.client.setHosts(sld, tld, allRecords);

    // Re-read to get the server-assigned HostId
    const updated = await this.client.getHosts(sld, tld);
    const created = updated.find(
      (r) => r.name === host && r.type === type && r.address === value,
    );

    return created;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = dnsRecordSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecheap", "update", parsed.error.issues);
    }
    const { domain, host, type, value, ttl, priority } = parsed.data;
    const targetHostId = Number(id);

    const { sld, tld } = splitDomainForNamecheap(domain);

    // Read-modify-write: replace the matching record, set all back
    const existing = await this.client.getHosts(sld, tld);
    const updatedRecords = existing.map((r) => {
      if (r.hostId === targetHostId) {
        return {
          hostName: host,
          recordType: type,
          address: value,
          mxPref: priority ?? 0,
          ttl,
        };
      }
      return mapRecordToSetRecord(r);
    });

    await this.client.setHosts(sld, tld, updatedRecords);

    // Re-read to get the updated state
    const updated = await this.client.getHosts(sld, tld);
    return updated.find((r) => r.hostId === targetHostId);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapRecordToSetRecord(r: {
  readonly name: string;
  readonly type: string;
  readonly address: string;
  readonly mxPref: number;
  readonly ttl: number;
}) {
  return {
    hostName: r.name,
    recordType: r.type,
    address: r.address,
    mxPref: r.mxPref,
    ttl: r.ttl,
  };
}

function splitDomainForNamecheap(domain: string): { sld: string; tld: string } {
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
      return { sld, tld };
    }
  }

  const lastDot = lower.lastIndexOf(".");
  if (lastDot === -1) {
    return { sld: lower, tld: "" };
  }
  return { sld: lower.slice(0, lastDot), tld: lower.slice(lastDot + 1) };
}
