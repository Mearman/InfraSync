import Cloudflare from "cloudflare";
import type {
  BucketCreateParams,
  BucketEditParams,
} from "cloudflare/resources/r2/buckets/buckets.js";
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
import { findByName } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface R2BucketRefs {
  readonly id: RefToken;
  readonly name: RefToken;
  readonly storageClass: RefToken;
}

export const buildR2BucketRefs: RefBuilder<R2BucketRefs> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
  storageClass: new RefToken(resourceName, "storageClass"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

const locationEnumSchema = z.enum([
  "apac",
  "eeur",
  "enam",
  "weur",
  "wnam",
  "oc",
]);

const storageClassEnumSchema = z.enum(["Standard", "InfrequentAccess"]);

const jurisdictionEnumSchema = z.enum(["default", "eu", "fedramp"]);

export const r2BucketSpecSchema = z.object({
  kind: z.literal("R2Bucket"),
  /** Bucket name (identity field) */
  name: z.string().trim().min(1),
  /** Location hint for bucket creation */
  location: locationEnumSchema.optional(),
  /** Default storage class for newly uploaded objects */
  storageClass: storageClassEnumSchema.optional(),
  /** Jurisdiction for data residency */
  jurisdiction: jurisdictionEnumSchema.optional(),
});

export type R2BucketSpec = z.infer<typeof r2BucketSpecSchema>;

const resolvedSpecSchema = z.object({
  kind: z.literal("R2Bucket"),
  name: z.string().trim().min(1),
  location: locationEnumSchema.optional(),
  storageClass: storageClassEnumSchema.optional(),
  jurisdiction: jurisdictionEnumSchema.optional(),
});

const r2BucketStateSchema = z
  .looseObject({
    name: z.string().trim(),
    creation_date: z.string().trim().optional(),
    location: z.string().trim().optional(),
    storage_class: z.string().trim().optional(),
    jurisdiction: z.string().trim().optional(),
  })
  .brand<"CloudflareR2BucketState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  name: z.string().trim(),
  creation_date: z.string().trim().optional(),
  location: z.string().trim().optional(),
  storage_class: z.string().trim().optional(),
  jurisdiction: z.string().trim().optional(),
});

const identitySchema = r2BucketSpecSchema.pick({ name: true });

const desiredStateSchema = r2BucketSpecSchema.pick({
  storageClass: true,
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

// R2 buckets don't have a conventional `id` — use bucket name as ID
function getStateIdFromName(state: unknown): string {
  if (typeof state === "object" && state !== null && "name" in state) {
    if (typeof state.name === "string") return state.name;
  }
  throw new ProviderApiError("cloudflare", "getStateId", [
    {
      path: ["name"],
      message: "State object does not contain a valid 'name' field",
    },
  ]);
}

// ─── Codec schemas ───────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("R2Bucket"),
  name: z.string().trim().min(1),
  location: locationEnumSchema.optional(),
  storageClass: storageClassEnumSchema.optional(),
  jurisdiction: jurisdictionEnumSchema.optional(),
});

const R2_BUCKET_KIND = "R2Bucket" as const;

const codecOutputSchema = z.looseObject({
  name: z.string().trim(),
  location: z.string().trim().optional(),
  storage_class: z.string().trim().optional(),
  jurisdiction: z.string().trim().optional(),
});

const r2BucketZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.name,
    location: spec.location,
    storage_class: spec.storageClass,
    jurisdiction: spec.jurisdiction,
  }),
  encode: (state) => ({
    kind: R2_BUCKET_KIND,
    name: state.name,
    location:
      state.location !== undefined
        ? locationEnumSchema.parse(state.location)
        : undefined,
    storageClass:
      state.storage_class !== undefined
        ? storageClassEnumSchema.parse(state.storage_class)
        : undefined,
    jurisdiction:
      state.jurisdiction !== undefined
        ? jurisdictionEnumSchema.parse(state.jurisdiction)
        : undefined,
  }),
});

const cloudflareR2BucketCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return r2BucketZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return r2BucketZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class R2BucketResource implements ResourcePort<
  typeof r2BucketSpecSchema,
  typeof r2BucketStateSchema
> {
  readonly kind = "R2Bucket";
  readonly specSchema = r2BucketSpecSchema;
  readonly stateSchema = r2BucketStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = cloudflareR2BucketCodec;

  readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  constructor(
    private readonly client: Cloudflare,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId = getStateIdFromName;

  async read(spec: unknown): Promise<unknown> {
    const parsed = r2BucketSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    const result = await this.client.r2.buckets.list({
      account_id: this.resolvedScopes.get("accountId"),
      name_contains: parsed.data.name,
    });

    const buckets = result.buckets;
    if (buckets === undefined) return undefined;

    const match = findByName(buckets, parsed.data.name);
    if (match === undefined) return undefined;
    return validateApiResponse(match, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }
    const { name, location, storageClass, jurisdiction } = parsed.data;

    const params: BucketCreateParams = {
      account_id: this.resolvedScopes.get("accountId"),
      name,
    };
    if (location !== undefined) params.locationHint = location;
    if (storageClass !== undefined) params.storageClass = storageClass;
    if (jurisdiction !== undefined) params.jurisdiction = jurisdiction;

    const response = await this.client.r2.buckets.create(params);

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }
    const { storageClass, jurisdiction } = parsed.data;

    // R2 bucket edit requires storage_class — derive from spec or keep current
    const storageClassValue = storageClass ?? "Standard";

    const params: BucketEditParams = {
      account_id: this.resolvedScopes.get("accountId"),
      storage_class: storageClassValue,
    };
    if (jurisdiction !== undefined) params.jurisdiction = jurisdiction;

    const response = await this.client.r2.buckets.edit(id, params);

    return validateApiResponse(response, "update");
  }
}
