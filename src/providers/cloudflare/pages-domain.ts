import Cloudflare from "cloudflare";
import type { ResourcePort } from "../../core/provider.js";
import { RefToken } from "../../core/refs.js";
import type { RefBuilder } from "../../authoring/handles.js";
import { z } from "zod";
import { ProviderApiError } from "../../core/errors.js";
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
  projectName: z.string().min(1),
  /** The custom domain to attach (identity field) */
  domain: z.string().min(1),
});

export type PagesCustomDomainSpec = z.infer<typeof pagesCustomDomainSpecSchema>;

const pagesCustomDomainStateSchema = z
  .looseObject({
    id: z.string(),
    name: z.string(),
    domain_id: z.string().optional(),
    status: z.string(),
    zone_tag: z.string().optional(),
    certificate_authority: z.string().optional(),
    created_on: z.string().optional(),
  })
  .brand<"CloudflarePagesDomainState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  domain_id: z.string().optional(),
  status: z.string(),
  zone_tag: z.string().optional(),
  certificate_authority: z.string().optional(),
  created_on: z.string().optional(),
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

  constructor(
    private readonly client: Cloudflare,
    private readonly accountId: string,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = pagesCustomDomainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    const domains = await this.client.pages.projects.domains.list(
      parsed.data.projectName,
      { account_id: this.accountId },
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
        account_id: this.accountId,
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
        account_id: this.accountId,
        body: { name: parsed.data.domain },
      },
    );

    return validateApiResponse(response, "update");
  }
}
