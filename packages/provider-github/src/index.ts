import type {
  ProviderAdapter,
  ProviderPort,
  ResourcePort,
  ResolvedScopes,
  ResourceRegistry,
} from "@infrasync-org/core/provider";
import {
  defineProvider,
  ResourceRegistry as Registry,
} from "@infrasync-org/core/provider";
import { GitHubClient } from "./client.js";
import { githubConfigSchema } from "./config.js";
import { RepositoryResource } from "./repository.js";
import { BranchProtectionResource } from "./branch-protection.js";
import { TeamResource } from "./team.js";
import { ActionsSecretResource } from "./actions-secret.js";

// ─── Adapter descriptor ──────────────────────────────────────────────────────

/**
 * The GitHub adapter descriptor. Pass this to `infra.provider()`:
 *
 * ```typescript
 * import { github } from "@infrasync-org/github";
 *
 * const gh = infra.provider("gh", github, {
 *   token: infra.secret.env("GITHUB_TOKEN"),
 * });
 * ```
 */
export const github: ProviderAdapter<typeof githubConfigSchema> =
  defineProvider("github", () => new GitHubProvider());

export class GitHubProvider implements ProviderPort<typeof githubConfigSchema> {
  readonly name = "github";
  readonly configSchema = githubConfigSchema;

  /** Pluggable resource registry for extending GitHub resources. */
  readonly registry: ResourceRegistry = new Registry();

  private client: GitHubClient | undefined;

  constructor() {
    this.registry.register("Repository", (scopes) => {
      return new RepositoryResource(this.client, scopes);
    });

    this.registry.register("BranchProtection", (scopes) => {
      return new BranchProtectionResource(this.client, scopes);
    });

    this.registry.register("Team", (scopes) => {
      return new TeamResource(this.client, scopes);
    });

    this.registry.register("ActionsSecret", (scopes) => {
      return new ActionsSecretResource(this.client, scopes);
    });
  }

  async connect(config: unknown): Promise<void> {
    const result = githubConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(
        `GitHub config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      );
    }
    this.client = new GitHubClient(result.data.token, result.data.baseUrl);
    await Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.client = undefined;
    await Promise.resolve();
  }

  supportedKinds(): string[] {
    return this.registry.kinds();
  }

  resourceHandler(kind: string, scopes: ResolvedScopes): ResourcePort {
    return this.registry.create(kind, scopes);
  }
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export type { GitHubConfig } from "./config.js";
export { githubConfigSchema } from "./config.js";
export {
  RepositoryResource,
  repositorySpecSchema,
  buildRepositoryRefs,
  type RepositorySpec,
  type RepositoryRefs,
} from "./repository.js";
export {
  BranchProtectionResource,
  branchProtectionSpecSchema,
  buildBranchProtectionRefs,
  type BranchProtectionSpec,
  type BranchProtectionRefs,
} from "./branch-protection.js";
export {
  TeamResource,
  teamSpecSchema,
  buildTeamRefs,
  type TeamSpec,
  type TeamRefs,
} from "./team.js";
export {
  ActionsSecretResource,
  actionsSecretSpecSchema,
  buildActionsSecretRefs,
  type ActionsSecretSpec,
  type ActionsSecretRefs,
} from "./actions-secret.js";
export { createGitHubHandle, type GitHubProviderHandle } from "./handle.js";
