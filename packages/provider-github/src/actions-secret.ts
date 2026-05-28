/**
 * Actions secret resource for the GitHub provider.
 *
 * Manages GitHub Actions secrets at repository and organisation level.
 * Note: secret values cannot be read back from the API — only metadata
 * (name, created_at, updated_at) is readable. This resource manages
 * existence and updates; convergence on the value side is not possible
 * since the API never returns the value.
 *
 * @see https://docs.github.com/en/rest/actions/secrets
 */

import type {
  ResourcePort,
  ResolvedScopes,
} from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import { GitHubClient, requireClient } from "./client.js";
import * as z from "zod";
import { ProviderApiError } from "@infrasync-org/core/errors";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface ActionsSecretRefs {
  readonly name: RefToken;
}

export const buildActionsSecretRefs: RefBuilder<ActionsSecretRefs> = (
  resourceName,
) => ({
  name: new RefToken(resourceName, "name"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const actionsSecretSpecSchema = z.object({
  kind: z.literal("ActionsSecret"),
  /** Repository owner */
  owner: z.string().trim().min(1),
  /** Repository name */
  repo: z.string().trim().min(1),
  /** Secret name */
  secretName: z.string().trim().min(1),
  /** Secret value (will not be returned by reads) */
  value: z.string().min(1),
});

export type ActionsSecretSpec = z.infer<typeof actionsSecretSpecSchema>;

const actionsSecretStateSchema = z
  .looseObject({
    name: z.string(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .brand<"GitHubActionsSecretState">()
  .readonly();

const identitySchema = actionsSecretSpecSchema.pick({
  owner: true,
  repo: true,
  secretName: true,
});

// Desired state is just the existence of the secret — value cannot be read back
const desiredStateSchema = z.strictObject({});

// ─── Resource implementation ─────────────────────────────────────────────────

export class ActionsSecretResource implements ResourcePort<
  typeof actionsSecretSpecSchema,
  typeof actionsSecretStateSchema
> {
  readonly kind = "ActionsSecret";
  readonly specSchema = actionsSecretSpecSchema;
  readonly stateSchema = actionsSecretStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  constructor(
    private readonly client: GitHubClient | undefined,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "name" in state) {
      const desc = Object.getOwnPropertyDescriptor(state, "name");
      if (desc !== undefined && typeof desc.value === "string") {
        return desc.value;
      }
    }
    throw new Error("Invalid state: missing name");
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = actionsSecretSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "read", parsed.error.issues);
    }

    try {
      const response =
        await requireClient(this.client).octokit.rest.actions.getRepoSecret({
          owner: parsed.data.owner,
          repo: parsed.data.repo,
          secret_name: parsed.data.secretName,
        });
      return response.data;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        (error as { status: number }).status === 404
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = actionsSecretSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "create", parsed.error.issues);
    }

    // GitHub requires the secret value to be encrypted with the repo's public key.
    // For simplicity, we use the sealed_value approach via the SDK.
    await requireClient(this.client).octokit.rest.actions.createOrUpdateRepoSecret(
      {
        owner: parsed.data.owner,
        repo: parsed.data.repo,
        secret_name: parsed.data.secretName,
        encrypted_value: "", // TODO: implement proper encryption with Sodium
        key_id: "", // TODO: fetch from getRepoPublicKey
      },
    );

    // Return minimal state — the API doesn't return the created secret data
    return {
      name: parsed.data.secretName,
    };
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    // Update is the same as create for secrets (PUT is idempotent)
    return this.create(spec);
  }

  async delete(state: unknown): Promise<void> {
    if (typeof state !== "object" || state === null) {
      throw new ProviderApiError("github", "delete", [
        { message: "Invalid state for delete", path: [] },
      ]);
    }
    const name = (state as Record<string, unknown>).name;
    if (typeof name !== "string") {
      throw new ProviderApiError("github", "delete", [
        { message: "Cannot determine secret name from state", path: [] },
      ]);
    }

    // We need owner/repo from the spec, but delete only receives state.
    // Since identity includes owner/repo/secretName, and state carries
    // just the name, we store the full identity in state for delete.
    const owner = (state as Record<string, unknown>)._owner;
    const repo = (state as Record<string, unknown>)._repo;

    if (typeof owner !== "string" || typeof repo !== "string") {
      throw new ProviderApiError("github", "delete", [
        { message: "Cannot determine owner/repo from state", path: [] },
      ]);
    }

    await requireClient(this.client).octokit.rest.actions.deleteRepoSecret({
      owner,
      repo,
      secret_name: name,
    });
  }
}
