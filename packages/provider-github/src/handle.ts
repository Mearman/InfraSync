import type {
  ResourceHandle,
  ResourceOptions,
  RefBuilder,
} from "@infrasync-org/core/handles";
import { createResourceHandle } from "@infrasync-org/core/handles";
import type { RepositoryRefs } from "./repository.js";
import { buildRepositoryRefs } from "./repository.js";
import type { BranchProtectionRefs } from "./branch-protection.js";
import { buildBranchProtectionRefs } from "./branch-protection.js";
import type { TeamRefs } from "./team.js";
import { buildTeamRefs } from "./team.js";
import type { ActionsSecretRefs } from "./actions-secret.js";
import { buildActionsSecretRefs } from "./actions-secret.js";
import type { RepositorySpec } from "./repository.js";
import type { BranchProtectionSpec } from "./branch-protection.js";
import type { TeamSpec } from "./team.js";
import type { ActionsSecretSpec } from "./actions-secret.js";

// ─── Registration function ───────────────────────────────────────────────────

export type ResourceRegistrar = (
  handle: ResourceHandle<unknown, unknown>,
) => void;

// ─── Typed GitHub handle ─────────────────────────────────────────────────────

export interface GitHubProviderHandle {
  readonly instanceKey: string;
  readonly adapterName: string;

  repository(
    id: string,
    spec: RepositorySpec,
    options?: ResourceOptions,
  ): ResourceHandle<RepositorySpec, RepositoryRefs>;

  branchProtection(
    id: string,
    spec: BranchProtectionSpec,
    options?: ResourceOptions,
  ): ResourceHandle<BranchProtectionSpec, BranchProtectionRefs>;

  team(
    id: string,
    spec: TeamSpec,
    options?: ResourceOptions,
  ): ResourceHandle<TeamSpec, TeamRefs>;

  actionsSecret(
    id: string,
    spec: ActionsSecretSpec,
    options?: ResourceOptions,
  ): ResourceHandle<ActionsSecretSpec, ActionsSecretRefs>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class GitHubProviderHandleImpl implements GitHubProviderHandle {
  constructor(
    readonly instanceKey: string,
    readonly adapterName: string,
    private readonly registerResource: ResourceRegistrar,
  ) {}

  repository(
    id: string,
    spec: RepositorySpec,
    options?: ResourceOptions,
  ): ResourceHandle<RepositorySpec, RepositoryRefs> {
    return this.typedResource(
      "Repository",
      id,
      spec,
      options,
      buildRepositoryRefs,
    );
  }

  branchProtection(
    id: string,
    spec: BranchProtectionSpec,
    options?: ResourceOptions,
  ): ResourceHandle<BranchProtectionSpec, BranchProtectionRefs> {
    return this.typedResource(
      "BranchProtection",
      id,
      spec,
      options,
      buildBranchProtectionRefs,
    );
  }

  team(
    id: string,
    spec: TeamSpec,
    options?: ResourceOptions,
  ): ResourceHandle<TeamSpec, TeamRefs> {
    return this.typedResource("Team", id, spec, options, buildTeamRefs);
  }

  actionsSecret(
    id: string,
    spec: ActionsSecretSpec,
    options?: ResourceOptions,
  ): ResourceHandle<ActionsSecretSpec, ActionsSecretRefs> {
    return this.typedResource(
      "ActionsSecret",
      id,
      spec,
      options,
      buildActionsSecretRefs,
    );
  }

  private typedResource<TSpec, TRefs>(
    kind: string,
    id: string,
    spec: TSpec,
    options: ResourceOptions | undefined,
    buildRefs: RefBuilder<TRefs>,
  ): ResourceHandle<TSpec, TRefs> {
    const handle = createResourceHandle(
      id,
      this.instanceKey,
      kind,
      spec,
      options,
      buildRefs,
    );
    this.registerResource(handle);
    return handle;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createGitHubHandle(
  instanceKey: string,
  adapterName: string,
  registerResource: ResourceRegistrar,
): GitHubProviderHandle {
  return new GitHubProviderHandleImpl(
    instanceKey,
    adapterName,
    registerResource,
  );
}
