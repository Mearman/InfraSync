import Cloudflare from "cloudflare";
import type { ResourcePort, ResourceCodec } from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import * as z from "zod";
import {
  dnsRecordSpecSchema,
  dnsRecordIdentitySchema,
  dnsRecordDesiredStateSchema,
} from "@infrasync-org/core/dns-record";
import { ProviderApiError } from "@infrasync-org/core/errors";
import { getStateId } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface DnsRecordRefs {
  readonly id: RefToken;
  readonly name: RefToken;
  readonly content: RefToken;
  readonly proxied: RefToken;
  readonly ttl: RefToken;
}

export const buildDnsRecordRefs: RefBuilder<DnsRecordRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
  content: new RefToken(resourceName, "content"),
  proxied: new RefToken(resourceName, "proxied"),
  ttl: new RefToken(resourceName, "ttl"),
});

// ─── Codec schemas ───────────────────────────────────────────────────────────

/**
 * Codec input schema: the resolved normalised spec after ref resolution.
 * All RefTokens have been replaced with concrete values by this point.
 */
const resolvedSpecSchema = z.object({
  kind: z.literal("DnsRecord"),
  domain: z.string().trim().min(1),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]),
  value: z.string().trim().min(1),
  ttl: z.int().min(0),
  proxied: z.boolean(),
});

/** DNS record kind literal — used in encode to satisfy the literal type. */
const DNS_RECORD_KIND = "DnsRecord" as const;

/** DNS record type enum schema — shared between codec schemas for narrowing. */
const dnsRecordTypeSchema = z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]);

/**
 * Codec output schema: Cloudflare DNS record fields.
 *
 * Uses looseObject so the codec accepts full API responses (with id, zone_id,
 * timestamps, etc.) for the encode direction. The decode direction only
 * produces the fields needed for SDK calls.
 */
const cloudflareDnsFieldsSchema = z.looseObject({
  type: z.string().trim(),
  name: z.string().trim(),
  content: z.string().trim().optional(),
  ttl: z.coerce.number(),
  proxied: z.coerce.boolean(),
});

// ─── Internal ZodCodec ──────────────────────────────────────────────────────

/**
 * Bidirectional ZodCodec between normalised DNS record spec and
 * Cloudflare-specific DNS record fields.
 *
 * - decode: normalised → Cloudflare (field mapping before SDK calls)
 * - encode: Cloudflare → normalised (normalise for convergence checking)
 */
const zodCodec = z.codec(resolvedSpecSchema, cloudflareDnsFieldsSchema, {
  // Normalised → Cloudflare
  decode: (spec) => ({
    type: spec.type,
    name: spec.domain,
    content: spec.value,
    ttl: spec.ttl,
    proxied: spec.proxied,
  }),

  // Cloudflare → normalised
  encode: (state) => ({
    kind: DNS_RECORD_KIND,
    domain: state.name,
    type: dnsRecordTypeSchema.parse(state.type),
    value: state.content ?? "",
    ttl: Number(state.ttl),
    proxied: Boolean(state.proxied),
  }),
});

// ─── External ResourceCodec ─────────────────────────────────────────────────

/**
 * ResourceCodec wrapper that accepts `unknown` at its boundaries.
 *
 * Validates internally using Zod schemas before delegating to the ZodCodec
 * for the actual field mapping. This matches the ResourcePort's own boundary
 * pattern — all public methods accept `unknown` and validate before use.
 */
const cloudflareDnsCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = cloudflareDnsFieldsSchema.safeParse(state);
    if (!result.success) return state;
    return zodCodec.encode(result.data);
  },

  decode(spec: unknown): unknown {
    const result = resolvedSpecSchema.safeParse(spec);
    if (!result.success) return spec;
    return zodCodec.decode(result.data);
  },
};

// ─── State schema ────────────────────────────────────────────────────────────

/**
 * Full Cloudflare DNS record state — validated against raw API responses.
 * Includes identity fields (id, zone_id) that the codec doesn't map.
 */
const dnsRecordStateSchema = z
  .looseObject({
    id: z.string().trim(),
    zone_id: z.string().trim(),
    type: z.string().trim(),
    name: z.string().trim(),
    content: z.string().trim().optional(),
    proxied: z.coerce.boolean(),
    ttl: z.coerce.number(),
  })
  .brand<"CloudflareDnsState">()
  .readonly();

// ─── API response schema (adapter-internal) ──────────────────────────────────

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  zone_id: z.string().trim(),
  type: z.string().trim(),
  name: z.string().trim(),
  content: z.string().trim().optional(),
  proxied: z.coerce.boolean(),
  ttl: z.coerce.number(),
  created_on: z.string().trim().optional(),
  modified_on: z.string().trim().optional(),
  proxiable: z.boolean().optional(),
  meta: z.json().optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractZone(domain: string): string {
  const parts = domain.split(".");
  return parts.slice(-2).join(".");
}

function validateApiResponse(
  raw: unknown,
  operation: string,
): z.infer<typeof apiResponseSchema> {
  const result = apiResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new ProviderApiError("cloudflare", operation, result.error.issues);
  }
  return result.data;
}

/**
 * Parse the resolved spec (after ref resolution) through the strict schema.
 * By this point all RefTokens have been replaced with concrete values,
 * so the refable union is gone and we get plain types.
 */
function parseResolvedSpec(
  resolvedSpec: unknown,
  operation: string,
): z.infer<typeof resolvedSpecSchema> {
  const result = resolvedSpecSchema.safeParse(resolvedSpec);
  if (!result.success) {
    throw new ProviderApiError("cloudflare", operation, result.error.issues);
  }
  return result.data;
}

// ─── Resource implementation ─────────────────────────────────────────────────

export class DnsRecordResource implements ResourcePort<
  typeof dnsRecordSpecSchema,
  typeof dnsRecordStateSchema
> {
  readonly kind = "DnsRecord";
  readonly specSchema = dnsRecordSpecSchema;
  readonly stateSchema = dnsRecordStateSchema;
  readonly identitySchema = dnsRecordIdentitySchema;
  readonly desiredStateSchema = dnsRecordDesiredStateSchema;
  readonly codec = cloudflareDnsCodec;

  constructor(private readonly client: Cloudflare) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = dnsRecordSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }
    const { domain, type } = parsed.data;
    const zone = extractZone(domain);

    const zones = await this.client.zones.list({ name: zone });
    const zoneRecord = zones.result[0];
    if (zoneRecord === undefined) return undefined;

    const records = await this.client.dns.records.list({
      zone_id: zoneRecord.id,
      type,
      name: { exact: domain },
    });

    const record = records.result[0];
    if (record === undefined) return undefined;

    return validateApiResponse(record, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const resolved = parseResolvedSpec(spec, "create");
    const cfParams = zodCodec.decode(resolved);
    const zone = extractZone(cfParams.name);

    const zones = await this.client.zones.list({ name: zone });
    const zoneRecord = zones.result[0];
    if (zoneRecord === undefined) {
      throw new ProviderApiError("cloudflare", "create", [
        { path: ["domain"], message: `Zone "${zone}" not found` },
      ]);
    }

    const response = await this.client.dns.records.create({
      zone_id: zoneRecord.id,
      name: cfParams.name,
      type: resolved.type,
      content: cfParams.content ?? resolved.value,
      ttl: cfParams.ttl,
      proxied: cfParams.proxied,
    });

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const resolved = parseResolvedSpec(spec, "update");
    const cfParams = zodCodec.decode(resolved);
    const zone = extractZone(cfParams.name);

    const zones = await this.client.zones.list({ name: zone });
    const zoneRecord = zones.result[0];
    if (zoneRecord === undefined) {
      throw new ProviderApiError("cloudflare", "update", [
        { path: ["domain"], message: `Zone "${zone}" not found` },
      ]);
    }

    const response = await this.client.dns.records.update(id, {
      zone_id: zoneRecord.id,
      name: cfParams.name,
      type: resolved.type,
      content: cfParams.content ?? resolved.value,
      ttl: cfParams.ttl,
      proxied: cfParams.proxied,
    });

    return validateApiResponse(response, "update");
  }
}
