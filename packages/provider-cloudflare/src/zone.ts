import Cloudflare from "cloudflare";
import type {
  ZoneCreateParams,
  ZoneEditParams,
} from "cloudflare/resources/zones/zones.js";
import type {
  ResourcePort,
  ResourceCodec,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync-org/core/errors";
import { getStateId } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface ZoneRefs {
  readonly id: RefToken;
  readonly name: RefToken;
  readonly nameServers: RefToken;
  readonly status: RefToken;
}

export const buildZoneRefs: RefBuilder<ZoneRefs> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
  nameServers: new RefToken(resourceName, "nameServers"),
  status: new RefToken(resourceName, "status"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const zoneSpecSchema = z.object({
  kind: z.literal("Zone"),
  /** Domain name (identity field) */
  name: z.string().trim().min(1),
  /** Zone type: full (DNS hosted on CF) or partial (CNAME setup) */
  type: z.enum(["full", "partial"]).default("full"),
  /** Whether the zone uses DNS-only mode (no proxy) */
  paused: z.boolean().optional(),
});

export type ZoneSpec = z.infer<typeof zoneSpecSchema>;

const resolvedSpecSchema = z.object({
  kind: z.literal("Zone"),
  name: z.string().trim().min(1),
  type: z.enum(["full", "partial"]).optional(),
  paused: z.boolean().optional(),
});

const zoneStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    status: z.string().trim().optional(),
    paused: z.boolean().optional(),
    type: z.string().trim().optional(),
    name_servers: z.array(z.string().trim()).optional(),
    created_on: z.string().trim().optional(),
    modified_on: z.string().trim().optional(),
    activated_on: z.string().trim().nullable().optional(),
    development_mode: z.number().optional(),
  })
  .brand<"CloudflareZoneState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  name: z.string().trim(),
  status: z.string().trim().optional(),
  paused: z.boolean().optional(),
  type: z.string().trim().optional(),
  name_servers: z.array(z.string().trim()).optional(),
  created_on: z.string().trim().optional(),
  modified_on: z.string().trim().optional(),
  activated_on: z.string().trim().nullable().optional(),
  development_mode: z.number().optional(),
});

const identitySchema = zoneSpecSchema.pick({ name: true });

const desiredStateSchema = zoneSpecSchema.pick({
  type: true,
  paused: true,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Codec schemas ───────────────────────────────────────────────────────────

const zoneTypeEnumSchema = z.enum(["full", "partial"]);

const codecInputSchema = z.object({
  kind: z.literal("Zone"),
  name: z.string().trim().min(1),
  type: zoneTypeEnumSchema.optional(),
  paused: z.boolean().optional(),
});

const ZONE_KIND = "Zone" as const;

const codecOutputSchema = z.looseObject({
  name: z.string().trim(),
  type: z.string().trim().optional(),
  paused: z.boolean().optional(),
});

const zoneZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.name,
    type: spec.type,
    paused: spec.paused,
  }),
  encode: (state) => ({
    kind: ZONE_KIND,
    name: state.name,
    type:
      state.type !== undefined
        ? zoneTypeEnumSchema.parse(state.type)
        : undefined,
    paused: state.paused,
  }),
});

const cloudflareZoneCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return zoneZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return zoneZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class ZoneResource implements ResourcePort<
  typeof zoneSpecSchema,
  typeof zoneStateSchema
> {
  readonly kind = "Zone";
  readonly specSchema = zoneSpecSchema;
  readonly stateSchema = zoneStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = cloudflareZoneCodec;

  readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  constructor(
    private readonly client: Cloudflare,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = zoneSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    const zones = await this.client.zones.list({
      name: parsed.data.name,
      account: { id: this.resolvedScopes.get("accountId") },
    });

    const zone = zones.result[0];
    if (zone === undefined) return undefined;
    return validateApiResponse(zone, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }
    const { name, type, paused } = parsed.data;

    const createParams: ZoneCreateParams = {
      account: { id: this.resolvedScopes.get("accountId") },
      name,
    };
    if (type !== undefined) createParams.type = type;

    const response = await this.client.zones.create(createParams);

    // Apply paused flag separately — create doesn't support it in body
    if (paused !== undefined) {
      const zoneId = validateApiResponse(response, "create").id;
      const editParams: ZoneEditParams = { zone_id: zoneId, paused };
      const updated = await this.client.zones.edit(editParams);
      return validateApiResponse(updated, "create");
    }

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }
    const { paused } = parsed.data;

    const editParams: ZoneEditParams = { zone_id: id };
    if (paused !== undefined) editParams.paused = paused;

    const response = await this.client.zones.edit(editParams);

    return validateApiResponse(response, "update");
  }
}
