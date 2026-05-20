import { Vercel } from "@vercel/sdk";
import { CreateProjectFramework } from "@vercel/sdk/models/createprojectto.js";
import type { ResourcePort, ResourceCodec } from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface ProjectRefs {
  readonly id: RefToken;
  readonly name: RefToken;
}

export const buildProjectRefs: RefBuilder<ProjectRefs> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const projectSpecSchema = z.object({
  kind: z.literal("Project"),
  name: z.string().trim().min(1),
  /** Framework preset — uses the Vercel SDK's canonical framework enum */
  framework: z.enum(CreateProjectFramework).optional(),
  /** Root directory for the project within the repository */
  rootDirectory: z.string().trim().optional(),
  /** Build command override */
  buildCommand: z.string().trim().optional(),
  /** Output directory override */
  outputDirectory: z.string().trim().optional(),
  /** Install command override */
  installCommand: z.string().trim().optional(),
  /** Dev command override */
  devCommand: z.string().trim().optional(),
  /** Whether the project is paused */
  paused: z.boolean().optional(),
});

export type ProjectSpec = z.infer<typeof projectSpecSchema>;

const projectStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    framework: z.string().trim().optional(),
    rootDirectory: z.string().trim().optional(),
    buildCommand: z.string().trim().optional(),
    outputDirectory: z.string().trim().optional(),
    installCommand: z.string().trim().optional(),
    devCommand: z.string().trim().optional(),
  })
  .brand<"VercelProjectState">()
  .readonly();

const identitySchema = projectSpecSchema.pick({
  name: true,
});

const desiredStateSchema = projectSpecSchema.pick({
  name: true,
  framework: true,
  rootDirectory: true,
  buildCommand: true,
  outputDirectory: true,
  installCommand: true,
  devCommand: true,
});

// ─── Codec schemas ───────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("Project"),
  name: z.string().trim().min(1),
  framework: z.enum(CreateProjectFramework).optional(),
  rootDirectory: z.string().trim().optional(),
  buildCommand: z.string().trim().optional(),
  outputDirectory: z.string().trim().optional(),
  installCommand: z.string().trim().optional(),
  devCommand: z.string().trim().optional(),
  paused: z.boolean().optional(),
});

const PROJECT_KIND = "Project" as const;

const codecOutputSchema = z.looseObject({
  id: z.string().trim().optional(),
  name: z.string().trim().optional(),
  framework: z.enum(CreateProjectFramework).nullable().optional(),
  rootDirectory: z.string().trim().nullable().optional(),
  buildCommand: z.string().trim().nullable().optional(),
  outputDirectory: z.string().trim().nullable().optional(),
  installCommand: z.string().trim().nullable().optional(),
  devCommand: z.string().trim().nullable().optional(),
});

const projectZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.name,
    framework: spec.framework ?? null,
    rootDirectory: spec.rootDirectory ?? null,
    buildCommand: spec.buildCommand ?? null,
    outputDirectory: spec.outputDirectory ?? null,
    installCommand: spec.installCommand ?? null,
    devCommand: spec.devCommand ?? null,
  }),
  encode: (state) => ({
    kind: PROJECT_KIND,
    name: state.name ?? "",
    framework: state.framework ?? undefined,
    rootDirectory: state.rootDirectory ?? undefined,
    buildCommand: state.buildCommand ?? undefined,
    outputDirectory: state.outputDirectory ?? undefined,
    installCommand: state.installCommand ?? undefined,
    devCommand: state.devCommand ?? undefined,
  }),
});

const vercelProjectCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return projectZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return projectZodCodec.decode(result.data);
  },
};

// ─── API response schema (adapter-internal) ──────────────────────────────────

const nameBearerSchema = z.object({ name: z.string().trim() });

/** Schema for SDK list-projects response shape */
const projectsResponseSchema = z.object({
  projects: z.array(z.unknown()),
});

// ─── Resource implementation ─────────────────────────────────────────────────

export class ProjectResource implements ResourcePort<
  typeof projectSpecSchema,
  typeof projectStateSchema
> {
  readonly kind = "Project";
  readonly specSchema = projectSpecSchema;
  readonly stateSchema = projectStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = vercelProjectCodec;

  constructor(private readonly client: Vercel) {}

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
    const parsed = projectSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "read", parsed.error.issues);
    }
    const { name } = parsed.data;

    // List projects and find by name
    const response = await this.client.projects.getProjects({
      search: name,
    });

    // The SDK returns a typed object — extract the projects array
    const projects = extractProjectsArray(response);
    if (projects === undefined) return undefined;

    const match = projects.find((p: unknown) => {
      const result = nameBearerSchema.safeParse(p);
      return result.success && result.data.name === name;
    });

    return match;
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = projectSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "create", parsed.error.issues);
    }
    const {
      name,
      framework,
      rootDirectory,
      buildCommand,
      outputDirectory,
      installCommand,
      devCommand,
    } = parsed.data;

    const response = await this.client.projects.createProject({
      requestBody: {
        name,
        framework,
        rootDirectory,
        buildCommand,
        outputDirectory,
        installCommand,
        devCommand,
      },
    });

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = projectSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "update", parsed.error.issues);
    }
    const {
      name,
      framework,
      rootDirectory,
      buildCommand,
      outputDirectory,
      installCommand,
      devCommand,
    } = parsed.data;

    const response = await this.client.projects.updateProject({
      idOrName: id,
      requestBody: {
        name,
        framework: framework ?? null,
        rootDirectory,
        buildCommand,
        outputDirectory,
        installCommand,
        devCommand,
      },
    });

    return validateApiResponse(response, "update");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the projects array from a getProjects response using Zod validation.
 */
function extractProjectsArray(response: unknown): unknown[] | undefined {
  const result = projectsResponseSchema.safeParse(response);
  if (!result.success) return undefined;
  return result.data.projects;
}

function validateApiResponse(raw: unknown, operation: string): unknown {
  const result = nameBearerSchema.safeParse(raw);
  if (!result.success) {
    throw new ProviderApiError("vercel", operation, [
      {
        path: ["id"],
        message:
          "API response missing expected 'name' field — may not be a valid project",
      },
    ]);
  }
  return raw;
}
