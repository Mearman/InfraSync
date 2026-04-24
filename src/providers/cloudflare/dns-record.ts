import Cloudflare from "cloudflare";
import type { ResourcePort } from "../../core/provider.js";
import { RefToken } from "../../core/refs.js";
import type { RefBuilder } from "../../authoring/handles.js";
import { z } from "zod";
import {
  dnsRecordSpecSchema,
  dnsRecordIdentitySchema,
  dnsRecordDesiredStateSchema,
} from "../../core/schemas/dns-record.js";
import { ProviderApiError } from "../../core/errors.js";

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
    id: z.string(),
    zone_id: z.string(),
    type: z.string(),
    name: z.string(),
    content: z.string().optional(),
    proxied: z.coerce.boolean(),
    ttl: z.coerce.number(),
  })
  .brand<"CloudflareDnsState">()
  .readonly();

// ─── API response schema (adapter-internal) ──────────────────────────────────

const apiResponseSchema = z.looseObject({
  id: z.string(),
  zone_id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string().optional(),
  proxied: z.coerce.boolean(),
  ttl: z.coerce.number(),
  created_on: z.string().optional(),
  modified_on: z.string().optional(),
  proxiable: z.boolean().optional(),
  meta: z.unknown().optional(),
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
  domain: z.string().min(1),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]),
  value: z.string().min(1),
  ttl: z.number().int().min(0),
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

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      const obj = state;
      if ("id" in obj && typeof obj.id === "string") return obj.id;
    }
    throw new ProviderApiError("cloudflare", "getStateId", [
      {
        path: ["id"],
        message: "State object does not contain a valid 'id' field",
      },
    ]);
  }

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
