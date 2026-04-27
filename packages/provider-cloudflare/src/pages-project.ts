import Cloudflare from "cloudflare";
import type {
  ResourcePort,
  ResourceCodec,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";
import { getStateId } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface PagesProjectRefs {
  readonly id: RefToken;
  readonly name: RefToken;
  readonly subdomain: RefToken;
  readonly productionBranch: RefToken;
}

export const buildPagesProjectRefs: RefBuilder<PagesProjectRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
  subdomain: new RefToken(resourceName, "subdomain"),
  productionBranch: new RefToken(resourceName, "productionBranch"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const pagesProjectSpecSchema = z.object({
  kind: z.literal("PagesProject"),
  /** Project name (identity field) */
  name: z.string().trim().min(1),
  /** Production branch for deployments */
  productionBranch: z.string().trim().optional(),
  /** Build configuration */
  buildConfig: z
    .object({
      buildCommand: z.string().trim().optional(),
      destinationDir: z.string().trim().optional(),
      rootDir: z.string().trim().optional(),
      buildCaching: z.boolean().optional(),
    })
    .optional(),
});

export type PagesProjectSpec = z.infer<typeof pagesProjectSpecSchema>;

const resolvedSpecSchema = z.object({
  kind: z.literal("PagesProject"),
  name: z.string().trim().min(1),
  productionBranch: z.string().trim().optional(),
  buildConfig: z
    .object({
      buildCommand: z.string().trim().optional(),
      destinationDir: z.string().trim().optional(),
      rootDir: z.string().trim().optional(),
      buildCaching: z.boolean().optional(),
    })
    .optional(),
});

const pagesProjectStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    subdomain: z.string().trim().optional(),
    production_branch: z.string().trim().optional(),
    domains: z.array(z.string().trim()).optional(),
    created_on: z.string().trim().optional(),
    build_config: z
      .looseObject({
        build_command: z.string().trim().nullable().optional(),
        destination_dir: z.string().trim().nullable().optional(),
        root_dir: z.string().trim().nullable().optional(),
        build_caching: z.boolean().nullable().optional(),
      })
      .optional(),
  })
  .brand<"CloudflarePagesProjectState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  name: z.string().trim(),
  subdomain: z.string().trim().optional(),
  production_branch: z.string().trim().optional(),
  domains: z.array(z.string().trim()).optional(),
  created_on: z.string().trim().optional(),
  build_config: z
    .looseObject({
      build_command: z.string().trim().nullable().optional(),
      destination_dir: z.string().trim().nullable().optional(),
      root_dir: z.string().trim().nullable().optional(),
      build_caching: z.boolean().nullable().optional(),
    })
    .optional(),
});

const identitySchema = pagesProjectSpecSchema.pick({ name: true });

const desiredStateSchema = pagesProjectSpecSchema.pick({
  productionBranch: true,
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

const codecInputSchema = z.object({
  kind: z.literal("PagesProject"),
  name: z.string().trim().min(1),
  productionBranch: z.string().trim().optional(),
  buildConfig: z
    .object({
      buildCommand: z.string().trim().optional(),
      destinationDir: z.string().trim().optional(),
      rootDir: z.string().trim().optional(),
      buildCaching: z.boolean().optional(),
    })
    .optional(),
});

const PAGES_PROJECT_KIND = "PagesProject" as const;

const codecOutputSchema = z.looseObject({
  name: z.string().trim(),
  production_branch: z.string().trim().optional(),
  build_config: z
    .looseObject({
      build_command: z.string().trim().nullable().optional(),
      destination_dir: z.string().trim().nullable().optional(),
      root_dir: z.string().trim().nullable().optional(),
      build_caching: z.boolean().nullable().optional(),
    })
    .optional(),
});

const pagesProjectZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.name,
    production_branch: spec.productionBranch,
    build_config:
      spec.buildConfig !== undefined
        ? {
            build_command: spec.buildConfig.buildCommand ?? null,
            destination_dir: spec.buildConfig.destinationDir ?? null,
            root_dir: spec.buildConfig.rootDir ?? null,
            build_caching: spec.buildConfig.buildCaching ?? null,
          }
        : undefined,
  }),
  encode: (state) => {
    const buildConfig = state.build_config;
    return {
      kind: PAGES_PROJECT_KIND,
      name: state.name,
      productionBranch: state.production_branch,
      buildConfig:
        buildConfig !== undefined
          ? {
              buildCommand: buildConfig.build_command ?? undefined,
              destinationDir: buildConfig.destination_dir ?? undefined,
              rootDir: buildConfig.root_dir ?? undefined,
              buildCaching: buildConfig.build_caching ?? undefined,
            }
          : undefined,
    };
  },
});

const cloudflarePagesProjectCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return pagesProjectZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return pagesProjectZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class PagesProjectResource implements ResourcePort<
  typeof pagesProjectSpecSchema,
  typeof pagesProjectStateSchema
> {
  readonly kind = "PagesProject";
  readonly specSchema = pagesProjectSpecSchema;
  readonly stateSchema = pagesProjectStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = cloudflarePagesProjectCodec;

  readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  constructor(
    private readonly client: Cloudflare,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = pagesProjectSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    // Pages project uses name as the identifier — try to get directly
    try {
      const project = await this.client.pages.projects.get(parsed.data.name, {
        account_id: this.resolvedScopes.get("accountId"),
      });
      return validateApiResponse(project, "read");
    } catch {
      return undefined;
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }
    const { name, productionBranch, buildConfig } = parsed.data;

    const params: {
      account_id: string;
      name: string;
      production_branch?: string;
      build_config?: {
        build_command?: string | null;
        destination_dir?: string | null;
        root_dir?: string | null;
        build_caching?: boolean | null;
      };
    } = {
      account_id: this.resolvedScopes.get("accountId"),
      name,
    };
    if (productionBranch !== undefined)
      params.production_branch = productionBranch;
    if (buildConfig !== undefined) {
      params.build_config = {
        build_command: buildConfig.buildCommand ?? null,
        destination_dir: buildConfig.destinationDir ?? null,
        root_dir: buildConfig.rootDir ?? null,
        build_caching: buildConfig.buildCaching ?? null,
      };
    }

    const response = await this.client.pages.projects.create(params);

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }

    // Pages projects use name (not id) as the identifier in API calls
    const { productionBranch, buildConfig } = parsed.data;

    const params: {
      account_id: string;
      production_branch?: string;
      build_config?: {
        build_command?: string | null;
        destination_dir?: string | null;
        root_dir?: string | null;
        build_caching?: boolean | null;
      };
    } = {
      account_id: this.resolvedScopes.get("accountId"),
    };
    if (productionBranch !== undefined)
      params.production_branch = productionBranch;
    if (buildConfig !== undefined) {
      params.build_config = {
        build_command: buildConfig.buildCommand ?? null,
        destination_dir: buildConfig.destinationDir ?? null,
        root_dir: buildConfig.rootDir ?? null,
        build_caching: buildConfig.buildCaching ?? null,
      };
    }

    const response = await this.client.pages.projects.edit(id, params);

    return validateApiResponse(response, "update");
  }
}
