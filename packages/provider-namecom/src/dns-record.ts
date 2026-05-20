import { NamecomClient } from "./client.js";
import type { ResourcePort, ResourceCodec } from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";

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

const dnsRecordTypeSchema = z.enum([
  "A",
  "AAAA",
  "ANAME",
  "CNAME",
  "MX",
  "NS",
  "SRV",
  "TXT",
]);

export const dnsRecordSpecSchema = z.object({
  kind: z.literal("DnsRecord"),
  /** The zone (domain name) this record belongs to */
  domain: z.string().trim().min(1),
  /** Hostname relative to the zone (e.g. "www", "@" for apex) */
  host: z.string().trim(),
  /** Record type */
  type: dnsRecordTypeSchema,
  /** Record answer/value (IP, target, text) */
  answer: z.string().trim().min(1),
  /** TTL in seconds (minimum 300) */
  ttl: z.int().min(300),
  /** Priority (MX and SRV only) */
  priority: z.int().min(0).optional(),
});

export type DnsRecordSpec = z.infer<typeof dnsRecordSpecSchema>;

const dnsRecordStateSchema = z
  .looseObject({
    id: z.coerce.number(),
    domainName: z.string().trim(),
    host: z.string().trim(),
    fqdn: z.string().trim(),
    type: z.string().trim(),
    answer: z.string().trim(),
    ttl: z.coerce.number(),
    priority: z.coerce.number().optional(),
  })
  .brand<"NamecomDnsRecordState">()
  .readonly();

const identitySchema = dnsRecordSpecSchema.pick({
  domain: true,
  host: true,
  type: true,
  answer: true,
});

const desiredStateSchema = dnsRecordSpecSchema.pick({
  host: true,
  type: true,
  answer: true,
  ttl: true,
  priority: true,
});

// ─── Codec schemas ───────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("DnsRecord"),
  domain: z.string().trim().min(1),
  host: z.string().trim(),
  type: dnsRecordTypeSchema,
  answer: z.string().trim().min(1),
  ttl: z.int().min(300),
  priority: z.int().min(0).optional(),
});

const DNS_RECORD_KIND = "DnsRecord" as const;

const codecOutputSchema = z.looseObject({
  id: z.coerce.number().optional(),
  domainName: z.string().trim().optional(),
  host: z.string().trim().optional(),
  fqdn: z.string().trim().optional(),
  type: z.string().trim().optional(),
  answer: z.string().trim().optional(),
  ttl: z.coerce.number().optional(),
  priority: z.coerce.number().optional(),
});

const dnsRecordZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    host: spec.host,
    type: spec.type,
    answer: spec.answer,
    ttl: spec.ttl,
    priority: spec.priority,
  }),
  encode: (state) => ({
    kind: DNS_RECORD_KIND,
    domain: state.domainName ?? "",
    host: state.host ?? "",
    type: dnsRecordTypeSchema.parse(state.type ?? "A"),
    answer: state.answer ?? "",
    ttl: Number(state.ttl),
    priority: state.priority !== undefined ? Number(state.priority) : undefined,
  }),
});

const namecomDnsCodec: ResourceCodec = {
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

// ─── API response schemas ────────────────────────────────────────────────────

const recordsResponseSchema = z.object({
  records: z.array(z.unknown()),
});

const hostBearerSchema = z.object({ host: z.string().trim() });
const typeBearerSchema = z.object({ type: z.string().trim() });
const answerBearerSchema = z.object({ answer: z.string().trim() });

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
  readonly codec = namecomDnsCodec;

  constructor(private readonly client: NamecomClient) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      if (typeof state.id === "number" || typeof state.id === "string") {
        return String(state.id);
      }
    }
    throw new ProviderApiError("namecom", "getStateId", [
      {
        path: ["id"],
        message: "State object does not contain a valid 'id' field",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = dnsRecordSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecom", "read", parsed.error.issues);
    }
    const { domain, host, type, answer } = parsed.data;

    const rawResponse = await this.client.listRecords(domain);
    const response = recordsResponseSchema.safeParse(rawResponse);
    if (!response.success) return undefined;

    const match = response.data.records.find((r: unknown) => {
      const hostResult = hostBearerSchema.safeParse(r);
      const typeResult = typeBearerSchema.safeParse(r);
      if (!hostResult.success || !typeResult.success) return false;
      if (hostResult.data.host !== host || typeResult.data.type !== type) {
        return false;
      }
      // answer is guaranteed non-empty by the spec schema (min(1))
      const answerResult = answerBearerSchema.safeParse(r);
      return answerResult.success && answerResult.data.answer === answer;
    });

    return match;
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = dnsRecordSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecom", "create", parsed.error.issues);
    }
    const { domain, host, type, answer, ttl, priority } = parsed.data;

    const record: {
      host: string;
      type: string;
      answer: string;
      ttl?: number;
      priority?: number;
    } = {
      host,
      type,
      answer,
    };
    record.ttl = ttl;
    if (priority !== undefined) record.priority = priority;

    return this.client.createRecord(domain, record);
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = dnsRecordSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("namecom", "update", parsed.error.issues);
    }
    const { domain, host, type, answer, ttl, priority } = parsed.data;

    const record: {
      host: string;
      type: string;
      answer: string;
      ttl?: number;
      priority?: number;
    } = {
      host,
      type,
      answer,
    };
    record.ttl = ttl;
    if (priority !== undefined) record.priority = priority;

    return this.client.updateRecord(domain, Number(id), record);
  }
}
