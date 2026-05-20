import { Vercel } from "@vercel/sdk";
import type {
  ResourcePort,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";

// ─── Narrowing helpers ───────────────────────────────────────────────────────

const keyBearerSchema = z.object({ key: z.string().trim() });

/** Schema for SDK list-envs response shape */
const envsResponseSchema = z.object({ envs: z.array(z.unknown()) });

/** Schema for SDK create-env response shape */
const createdResponseSchema = z.object({ created: z.array(z.unknown()) });

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface EnvironmentVariableRefs {
  readonly id: RefToken;
  readonly key: RefToken;
}

export const buildEnvironmentVariableRefs: RefBuilder<
  EnvironmentVariableRefs
> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  key: new RefToken(resourceName, "key"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

const environmentTypeSchema = z.enum(["production", "preview", "development"]);

export const environmentVariableSpecSchema = z.object({
  kind: z.literal("EnvironmentVariable"),
  /** The environment variable key */
  key: z.string().trim().min(1),
  /** The environment variable value */
  value: z.string().trim(),
  /** Which environments this variable is available in */
  environment: z.array(environmentTypeSchema).min(1),
  /** The project name or ID this env var belongs to */
  projectName: z.string().trim().min(1).optional(),
  /** Whether this variable is sensitive (encrypted) */
  sensitive: z.boolean().optional(),
});

export type EnvironmentVariableSpec = z.infer<
  typeof environmentVariableSpecSchema
>;

const environmentVariableStateSchema = z
  .looseObject({
    id: z.string().trim().optional(),
    uid: z.string().trim().optional(),
    key: z.string().trim(),
    value: z.string().trim().optional(),
    type: z.enum(["system", "encrypted", "plain"]).optional(),
    configurationId: z.string().trim().optional(),
    updatedAt: z.number().optional(),
    createdAt: z.number().optional(),
    target: z.array(z.string().trim()).optional(),
  })
  .brand<"VercelEnvironmentVariableState">()
  .readonly();

const identitySchema = z.object({
  key: z.string().trim().min(1),
  projectName: z.string().trim().min(1).optional(),
});

const desiredStateSchema = z.object({
  key: z.string().trim().min(1),
  value: z.string().trim(),
  environment: z.array(environmentTypeSchema).min(1),
});

// ─── Resource implementation ─────────────────────────────────────────────────

export class EnvironmentVariableResource implements ResourcePort<
  typeof environmentVariableSpecSchema,
  typeof environmentVariableStateSchema
> {
  readonly kind = "EnvironmentVariable";
  readonly specSchema = environmentVariableSpecSchema;
  readonly stateSchema = environmentVariableStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  readonly scopes: ResourceScopes = {
    projectId: { ref: "projectId" },
  };

  constructor(
    private readonly client: Vercel,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId(state: unknown): string {
    // Environment variables use either `id` or `uid`
    if (typeof state === "object" && state !== null) {
      if ("uid" in state && typeof state.uid === "string") return state.uid;
      if ("id" in state && typeof state.id === "string") return state.id;
    }
    throw new ProviderApiError("vercel", "getStateId", [
      {
        path: ["id"],
        message: "State object does not contain a valid 'id' or 'uid' field",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = environmentVariableSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "read", parsed.error.issues);
    }
    const { key, projectName } = parsed.data;

    const idOrName = projectName ?? this.resolveProjectIdOrName();

    // List env vars for the project and find by key
    const response = await this.client.projects.filterProjectEnvs({
      idOrName,
    });

    const envs = extractEnvsArray(response);
    if (envs === undefined) return undefined;

    const match = envs.find((e: unknown) => {
      const result = keyBearerSchema.safeParse(e);
      return result.success && result.data.key === key;
    });

    return match;
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = environmentVariableSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "create", parsed.error.issues);
    }
    const { key, value, environment, projectName, sensitive } = parsed.data;

    const idOrName = projectName ?? this.resolveProjectIdOrName();

    const response = await this.client.projects.createProjectEnv({
      idOrName,
      requestBody: [
        {
          key,
          value,
          target: environment,
          type: sensitive === true ? "encrypted" : "plain",
        },
      ],
    });

    // createProjectEnv returns { created: EnvVar[] }
    const created = extractCreatedArray(response);
    if (created !== undefined && created.length > 0) {
      return created[0];
    }

    return response;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = environmentVariableSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("vercel", "update", parsed.error.issues);
    }
    const { key, value, environment, projectName } = parsed.data;

    const idOrName = projectName ?? this.resolveProjectIdOrName();

    const response = await this.client.projects.editProjectEnv({
      idOrName,
      id,
      requestBody: {
        key,
        value,
        target: environment,
      },
    });

    return response;
  }

  private resolveProjectIdOrName(): string {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the envs array from a filterProjectEnvs response using Zod validation.
 */
function extractEnvsArray(response: unknown): unknown[] | undefined {
  const result = envsResponseSchema.safeParse(response);
  if (!result.success) return undefined;
  return result.data.envs;
}

/**
 * Extract the created array from a createProjectEnv response using Zod validation.
 */
function extractCreatedArray(response: unknown): unknown[] | undefined {
  const result = createdResponseSchema.safeParse(response);
  if (!result.success) return undefined;
  return result.data.created;
}
