import Cloudflare from "cloudflare";
import type { ResourcePort } from "../../core/provider.js";
import { RefToken } from "../../core/refs.js";
import type { RefBuilder } from "../../authoring/handles.js";
import * as z from "zod";
import {
  dnsRecordSpecSchema,
  dnsRecordIdentitySchema,
  dnsRecordDesiredStateSchema,
} from "../../core/schemas/dns-record.js";
import { ProviderApiError } from "../../core/errors.js";
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

// ─── State schema ────────────────────────────────────────────────────────────

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

// ─── SDK parameter schema ────────────────────────────────────────────────────

/**
 * Schema for the resolved spec after ref resolution.
 * By the time we call the Cloudflare SDK, all RefTokens have been replaced
 * with concrete values. This schema strips the refable union and validates
 * the plain fields the SDK expects.
 */
const resolvedSpecSchema = z.object({
  kind: z.literal("DnsRecord"),
  domain: z.string().trim().min(1),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]),
  value: z.string().trim().min(1),
  ttl: z.int().min(0),
  proxied: z.boolean(),
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
    const { domain, type, value, ttl, proxied } = parseResolvedSpec(
      spec,
      "create",
    );
    const zone = extractZone(domain);

    const zones = await this.client.zones.list({ name: zone });
    const zoneRecord = zones.result[0];
    if (zoneRecord === undefined) {
      throw new ProviderApiError("cloudflare", "create", [
        { path: ["domain"], message: `Zone "${zone}" not found` },
      ]);
    }

    const response = await this.client.dns.records.create({
      zone_id: zoneRecord.id,
      name: domain,
      type,
      content: value,
      ttl,
      proxied,
    });

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const { domain, type, value, ttl, proxied } = parseResolvedSpec(
      spec,
      "update",
    );
    const zone = extractZone(domain);

    const zones = await this.client.zones.list({ name: zone });
    const zoneRecord = zones.result[0];
    if (zoneRecord === undefined) {
      throw new ProviderApiError("cloudflare", "update", [
        { path: ["domain"], message: `Zone "${zone}" not found` },
      ]);
    }

    const response = await this.client.dns.records.update(id, {
      zone_id: zoneRecord.id,
      name: domain,
      type,
      content: value,
      ttl,
      proxied,
    });

    return validateApiResponse(response, "update");
  }
}
