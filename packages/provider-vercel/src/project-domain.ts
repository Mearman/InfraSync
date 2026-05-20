import { Vercel } from "@vercel/sdk";
import type {
  ResourcePort,
  ResourceScopes,
  ResourceCodec,
  ResolvedScopes,
} from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync-org/core/errors";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface ProjectDomainRefs {
  readonly id: RefToken;
  readonly name: RefToken;
}

export const buildProjectDomainRefs: RefBuilder<ProjectDomainRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const projectDomainSpecSchema = z.object({
  kind: z.literal("ProjectDomain"),
  /** The domain name to associate with the project */
  domain: z.string().trim().min(1),
  /** The project name or ID to associate the domain with */
  projectName: z.string().trim().min(1).optional(),
});

export type ProjectDomainSpec = z.infer<typeof projectDomainSpecSchema>;

const projectDomainStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    projectId: z.string().trim().optional(),
  })
  .brand<"VercelProjectDomainState">()
  .readonly();

const identitySchema = projectDomainSpecSchema.pick({
  domain: true,
  projectName: true,
});

const desiredStateSchema = projectDomainSpecSchema.pick({
  domain: true,
});

// ─── Codec schemas ───────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("ProjectDomain"),
  domain: z.string().trim().min(1),
  projectName: z.string().trim().min(1).optional(),
});

const PROJECT_DOMAIN_KIND = "ProjectDomain" as const;

const codecOutputSchema = z.looseObject({
  id: z.string().trim().optional(),
  name: z.string().trim().optional(),
});

const projectDomainZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.domain,
  }),
  encode: (state) => ({
    kind: PROJECT_DOMAIN_KIND,
    domain: state.name ?? "",
  }),
});

const vercelProjectDomainCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return projectDomainZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return projectDomainZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class ProjectDomainResource implements ResourcePort<
  typeof projectDomainSpecSchema,
  typeof projectDomainStateSchema
> {
  readonly kind = "ProjectDomain";
  readonly specSchema = projectDomainSpecSchema;
  readonly stateSchema = projectDomainStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = vercelProjectDomainCodec;

  readonly scopes: ResourceScopes = {
    projectId: { ref: "projectId" },
  };

  constructor(
    private readonly client: Vercel,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      if (typeof state.id === "string") return state.id;
    }
    throw new ProviderApiError("vercel", "getStateId", [
      {
        path: ["id"],
        message: "State object does not contain a valid 'id' field",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = projectDomainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "read", parsed.error.issues);
    }
    const { domain, projectName } = parsed.data;

    const idOrName = projectName ?? this.resolveProjectIdOrName();

    try {
      const response = await this.client.projects.getProjectDomain({
        idOrName,
        domain,
      });
      return response;
    } catch {
      return undefined;
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = projectDomainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "create", parsed.error.issues);
    }
    const { domain, projectName } = parsed.data;

    const idOrName = projectName ?? this.resolveProjectIdOrName();

    const response = await this.client.projects.addProjectDomain({
      idOrName,
      requestBody: {
        name: domain,
      },
    });

    return response;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = projectDomainSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "update", parsed.error.issues);
    }
    const { domain, projectName } = parsed.data;

    const idOrName = projectName ?? this.resolveProjectIdOrName();

    void id;

    const response = await this.client.projects.updateProjectDomain({
      idOrName,
      domain,
      requestBody: {},
    });

    return response;
  }

  private resolveProjectIdOrName(): string {
    // Try to get projectId from scopes; if not available, throw
    try {
      return this.resolvedScopes.get("projectId");
    } catch {
      throw new ProviderApiError("vercel", "resolveProjectIdOrName", [
        {
          path: ["projectName"],
          message:
            "Either 'projectName' must be specified in the spec or 'projectId' must be provided via scopes",
        },
      ]);
    }
  }
}
