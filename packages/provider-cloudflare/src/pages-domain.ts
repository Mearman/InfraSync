import Cloudflare from "cloudflare";
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

export interface PagesCustomDomainRefs {
  readonly id: RefToken;
  readonly name: RefToken;
  readonly status: RefToken;
}

export const buildPagesCustomDomainRefs: RefBuilder<PagesCustomDomainRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
  status: new RefToken(resourceName, "status"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const pagesCustomDomainSpecSchema = z.object({
  kind: z.literal("PagesCustomDomain"),
  /** The Pages project name (identity field) */
  projectName: z.string().trim().min(1),
  /** The custom domain to attach (identity field) */
  domain: z.string().trim().min(1),
});

export type PagesCustomDomainSpec = z.infer<typeof pagesCustomDomainSpecSchema>;

const pagesCustomDomainStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    domain_id: z.string().trim().optional(),
    status: z.string().trim(),
    zone_tag: z.string().trim().optional(),
    certificate_authority: z.string().trim().optional(),
    created_on: z.string().trim().optional(),
  })
  .brand<"CloudflarePagesDomainState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  name: z.string().trim(),
  domain_id: z.string().trim().optional(),
  status: z.string().trim(),
  zone_tag: z.string().trim().optional(),
  certificate_authority: z.string().trim().optional(),
  created_on: z.string().trim().optional(),
});

const identitySchema = pagesCustomDomainSpecSchema.pick({
  projectName: true,
  domain: true,
});

const desiredStateSchema = pagesCustomDomainSpecSchema.pick({ domain: true });

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

// ─── Codec schemas ──────────────────────────────────────────────────────────

// ─── Codec schemas ──────────────────────────────────────────────────────────
//
// The codec maps only bidirectionally mappable fields.
// projectName is identity-only (not in state) — not in the codec.
// It belongs in identitySchema, not here.

const codecInputSchema = z.object({
  kind: z.literal("PagesCustomDomain"),
  domain: z.string().trim().min(1),
});

const PAGES_DOMAIN_KIND = "PagesCustomDomain" as const;

const codecOutputSchema = z.looseObject({
  name: z.string().trim(),
});

const pagesDomainZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.domain,
  }),
  encode: (state) => ({
    kind: PAGES_DOMAIN_KIND,
    domain: state.name,
  }),
});

const cloudflarePagesDomainCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return pagesDomainZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return pagesDomainZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class PagesCustomDomainResource implements ResourcePort<
  typeof pagesCustomDomainSpecSchema,
  typeof pagesCustomDomainStateSchema
> {
  readonly kind = "PagesCustomDomain";
  readonly specSchema = pagesCustomDomainSpecSchema;
  readonly stateSchema = pagesCustomDomainStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = cloudflarePagesDomainCodec;

  static readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  constructor(
    private readonly client: Cloudflare,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = pagesCustomDomainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    const domains = await this.client.pages.projects.domains.list(
      parsed.data.projectName,
      { account_id: this.resolvedScopes.get("accountId") },
    );
    const match = domains.result.find((d) => {
      if ("name" in d && typeof d.name === "string") {
        return d.name === parsed.data.domain;
      }
      return false;
    });
    if (match === undefined) return undefined;
    return validateApiResponse(match, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = pagesCustomDomainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }

    const response = await this.client.pages.projects.domains.create(
      parsed.data.projectName,
      {
        account_id: this.resolvedScopes.get("accountId"),
        name: parsed.data.domain,
      },
    );

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = pagesCustomDomainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }

    const response = await this.client.pages.projects.domains.edit(
      parsed.data.projectName,
      id,
      {
        account_id: this.resolvedScopes.get("accountId"),
        body: { name: parsed.data.domain },
      },
    );

    return validateApiResponse(response, "update");
  }
}
