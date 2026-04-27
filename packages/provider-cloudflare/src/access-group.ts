import Cloudflare from "cloudflare";
import type {
  GroupCreateParams,
  GroupUpdateParams,
} from "cloudflare/resources/zero-trust/access/groups.js";
import type {
  ResourcePort,
  ResourceCodec,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync/core/provider";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";
import { getStateId, findByName } from "./helpers.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Access rule array schema.
 *
 * Same pattern as AccessPolicy — the Cloudflare SDK models access rules as
 * a discriminated union with dozens of variants. Our spec accepts arbitrary
 * objects — the SDK validates at the API boundary.
 */
const accessRuleArraySchema = z.array(z.json());

export const accessGroupSpecSchema = z.object({
  kind: z.literal("AccessGroup"),
  /** The group name (identity field) */
  name: z.string().trim().min(1),
  /** Rules evaluated with OR logic — user needs to match at least one */
  include: accessRuleArraySchema,
  /** Rules evaluated with NOT logic — user must not match any */
  exclude: accessRuleArraySchema.optional(),
});

export type AccessGroupSpec = z.infer<typeof accessGroupSpecSchema>;

const resolvedSpecSchema = z.object({
  kind: z.literal("AccessGroup"),
  name: z.string().trim().min(1),
  include: accessRuleArraySchema,
  exclude: accessRuleArraySchema.optional(),
});

const accessGroupStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    include: z.array(z.json()),
    exclude: z.array(z.json()).optional(),
    created_at: z.string().trim().optional(),
    updated_at: z.string().trim().optional(),
  })
  .brand<"CloudflareAccessGroupState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  name: z.string().trim(),
  include: z.array(z.json()),
  exclude: z.array(z.json()).optional(),
  created_at: z.string().trim().optional(),
  updated_at: z.string().trim().optional(),
});

const identitySchema = accessGroupSpecSchema.pick({ name: true });

const desiredStateSchema = accessGroupSpecSchema.pick({
  include: true,
  exclude: true,
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

function buildCreateParams(
  accountId: string,
  name: string,
  include: readonly unknown[],
  exclude: readonly unknown[] | undefined,
): GroupCreateParams {
  const params: GroupCreateParams = {
    account_id: accountId,
    name,
    include: Object.assign([], [...include]),
  };
  if (exclude !== undefined) {
    params.exclude = Object.assign([], [...exclude]);
  }
  return params;
}

function buildUpdateParams(
  accountId: string,
  name: string,
  include: readonly unknown[],
  exclude: readonly unknown[] | undefined,
): GroupUpdateParams {
  const params: GroupUpdateParams = {
    account_id: accountId,
    name,
    include: Object.assign([], [...include]),
  };
  if (exclude !== undefined) {
    params.exclude = Object.assign([], [...exclude]);
  }
  return params;
}

// ─── Codec schemas ───────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("AccessGroup"),
  name: z.string().trim().min(1),
  include: accessRuleArraySchema,
  exclude: accessRuleArraySchema.optional(),
});

const ACCESS_GROUP_KIND = "AccessGroup" as const;

const codecOutputSchema = z.looseObject({
  name: z.string().trim(),
  include: z.array(z.json()),
  exclude: z.array(z.json()).optional(),
});

const accessGroupZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.name,
    include: [...spec.include],
    exclude: spec.exclude !== undefined ? [...spec.exclude] : undefined,
  }),
  encode: (state) => ({
    kind: ACCESS_GROUP_KIND,
    name: state.name,
    include: state.include,
    exclude: state.exclude,
  }),
});

const cloudflareAccessGroupCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return accessGroupZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return accessGroupZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class AccessGroupResource implements ResourcePort<
  typeof accessGroupSpecSchema,
  typeof accessGroupStateSchema
> {
  readonly kind = "AccessGroup";
  readonly specSchema = accessGroupSpecSchema;
  readonly stateSchema = accessGroupStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = cloudflareAccessGroupCodec;

  readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  constructor(
    private readonly client: Cloudflare,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = accessGroupSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    const groups = await this.client.zeroTrust.access.groups.list({
      account_id: this.resolvedScopes.get("accountId"),
    });
    const match = findByName(groups.result, parsed.data.name);
    if (match === undefined) return undefined;
    return validateApiResponse(match, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }
    const { name, include, exclude } = parsed.data;

    const params = buildCreateParams(
      this.resolvedScopes.get("accountId"),
      name,
      include,
      exclude,
    );
    const response = await this.client.zeroTrust.access.groups.create(params);

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }
    const { name, include, exclude } = parsed.data;

    const params = buildUpdateParams(
      this.resolvedScopes.get("accountId"),
      name,
      include,
      exclude,
    );
    const response = await this.client.zeroTrust.access.groups.update(
      id,
      params,
    );

    return validateApiResponse(response, "update");
  }
}
