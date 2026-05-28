/**
 * Branch protection resource for the GitHub provider.
 *
 * Manages branch protection rules for GitHub repositories.
 *
 * @see https://docs.github.com/en/rest/branches/branch-protection
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

export interface BranchProtectionRefs {
  readonly id: RefToken;
}

export const buildBranchProtectionRefs: RefBuilder<BranchProtectionRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const branchProtectionSpecSchema = z.object({
  kind: z.literal("BranchProtection"),
  /** Repository owner */
  owner: z.string().trim().min(1),
  /** Repository name */
  repo: z.string().trim().min(1),
  /** Branch name pattern to protect */
  branch: z.string().trim().min(1),
  /** Whether enforce admin is enabled (applies to admins too) */
  enforceAdmins: z.boolean().optional(),
  /** Whether required status checks are enabled */
  requiredStatusChecks: z
    .strictObject({
      /** Whether PRs must be up to date before merging */
      strict: z.boolean().optional(),
      /** List of required status check context names */
      contexts: z.array(z.string().trim().min(1)).optional(),
    })
    .optional(),
  /** Required pull request review settings */
  requiredPullRequestReviews: z
    .strictObject({
      /** Number of required approving reviews */
      requiredApprovingReviewCount: z.int().min(1).max(6).optional(),
      /** Whether dismiss stale reviews on new commits */
      dismissStaleReviews: z.boolean().optional(),
      /** Whether code owner review is required */
      requireCodeOwnerReviews: z.boolean().optional(),
    })
    .optional(),
  /** Whether signed commits are required */
  requiredSignatures: z.boolean().optional(),
  /** Whether the branch is restricted to specific users/teams */
  restrictions: z
    .strictObject({
      /** Team slugs with push access */
      teams: z.array(z.string().trim().min(1)).optional(),
      /** Usernames with push access */
      users: z.array(z.string().trim().min(1)).optional(),
      /** App slugs with push access */
      apps: z.array(z.string().trim().min(1)).optional(),
    })
    .optional(),
  /** Whether force pushes are allowed */
  allowForcePushes: z.boolean().optional(),
  /** Whether deletions are allowed */
  allowDeletions: z.boolean().optional(),
  /** Whether linear history is required */
  requiredLinearHistory: z.boolean().optional(),
});

export type BranchProtectionSpec = z.infer<typeof branchProtectionSpecSchema>;

const branchProtectionStateSchema = z
  .looseObject({
    url: z.string().optional(),
    required_status_checks: z
      .looseObject({
        strict: z.boolean().optional(),
        contexts: z.array(z.string()).optional(),
      })
      .nullable()
      .optional(),
    enforce_admins: z
      .looseObject({
        enabled: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    required_pull_request_reviews: z
      .looseObject({
        required_approving_review_count: z.number().optional(),
        dismiss_stale_reviews: z.boolean().optional(),
        require_code_owner_reviews: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    required_signatures: z
      .looseObject({
        enabled: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    restrictions: z
      .looseObject({
        teams: z.array(z.looseObject({ slug: z.string() })).optional(),
        users: z.array(z.looseObject({ login: z.string() })).optional(),
        apps: z.array(z.looseObject({ slug: z.string() })).optional(),
      })
      .nullable()
      .optional(),
    allow_force_pushes: z
      .looseObject({
        enabled: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    allow_deletions: z
      .looseObject({
        enabled: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    required_linear_history: z
      .looseObject({
        enabled: z.boolean().optional(),
      })
      .nullable()
      .optional(),
  })
  .brand<"GitHubBranchProtectionState">()
  .readonly();

const identitySchema = branchProtectionSpecSchema.pick({
  owner: true,
  repo: true,
  branch: true,
});

const desiredStateSchema = branchProtectionSpecSchema.pick({
  enforceAdmins: true,
  requiredStatusChecks: true,
  requiredPullRequestReviews: true,
  requiredSignatures: true,
  restrictions: true,
  allowForcePushes: true,
  allowDeletions: true,
  requiredLinearHistory: true,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildProtectionBody(
  spec: z.infer<typeof branchProtectionSpecSchema>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  body.enforce_admins = spec.enforceAdmins ?? null;

  body.required_status_checks =
    spec.requiredStatusChecks !== undefined
      ? {
          strict: spec.requiredStatusChecks.strict ?? false,
          contexts: spec.requiredStatusChecks.contexts ?? [],
        }
      : null;

  body.required_pull_request_reviews =
    spec.requiredPullRequestReviews !== undefined
      ? {
          required_approving_review_count:
            spec.requiredPullRequestReviews.requiredApprovingReviewCount ?? 1,
          dismiss_stale_reviews:
            spec.requiredPullRequestReviews.dismissStaleReviews ?? false,
          require_code_owner_reviews:
            spec.requiredPullRequestReviews.requireCodeOwnerReviews ?? false,
        }
      : null;

  body.restrictions =
    spec.restrictions !== undefined
      ? {
          teams: spec.restrictions.teams ?? [],
          users: spec.restrictions.users ?? [],
          apps: spec.restrictions.apps ?? [],
        }
      : null;

  if (spec.requiredSignatures !== undefined)
    body.required_signatures = spec.requiredSignatures;
  if (spec.allowForcePushes !== undefined)
    body.allow_force_pushes = spec.allowForcePushes;
  if (spec.allowDeletions !== undefined)
    body.allow_deletions = spec.allowDeletions;
  if (spec.requiredLinearHistory !== undefined)
    body.required_linear_history = spec.requiredLinearHistory;

  return body;
}

// ─── Resource implementation ─────────────────────────────────────────────────

export class BranchProtectionResource implements ResourcePort<
  typeof branchProtectionSpecSchema,
  typeof branchProtectionStateSchema
> {
  readonly kind = "BranchProtection";
  readonly specSchema = branchProtectionSpecSchema;
  readonly stateSchema = branchProtectionStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  constructor(
    private readonly client: GitHubClient | undefined,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId(state: unknown): string {
    // Branch protection doesn't have a native ID — synthesise from URL
    if (typeof state === "object" && state !== null && "url" in state) {
      const url = (state as { url: string }).url;
      // URL format: https://api.github.com/repos/{owner}/{repo}/branches/{branch}/protection
      const match = url.match(
        /\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)\/protection$/,
      );
      if (match !== null) {
        return `${match[1]}/${match[2]}/${match[3]}`;
      }
    }
    throw new Error(
      "Invalid state: cannot determine owner/repo/branch from branch protection",
    );
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = branchProtectionSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "read", parsed.error.issues);
    }

    try {
      const { data } = await requireClient(this.client).octokit.request(
        "GET /repos/{owner}/{repo}/branches/{branch}/protection",
        {
          owner: parsed.data.owner,
          repo: parsed.data.repo,
          branch: parsed.data.branch,
        },
      );
      return data;
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
    const parsed = branchProtectionSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "create", parsed.error.issues);
    }

    const body = buildProtectionBody(parsed.data);
    const { data } = await requireClient(this.client).octokit.request(
      "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
      {
        owner: parsed.data.owner,
        repo: parsed.data.repo,
        branch: parsed.data.branch,
        ...body,
      } as never,
    );
    return data;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    // Branch protection is idempotent — same as create (PUT replaces entirely)
    const parsed = branchProtectionSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "update", parsed.error.issues);
    }

    const body = buildProtectionBody(parsed.data);
    const { data } = await requireClient(this.client).octokit.request(
      "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
      {
        owner: parsed.data.owner,
        repo: parsed.data.repo,
        branch: parsed.data.branch,
        ...body,
      } as never,
    );
    return data;
  }

  async delete(state: unknown): Promise<void> {
    if (typeof state !== "object" || state === null) {
      throw new ProviderApiError("github", "delete", [
        { message: "Invalid state for delete", path: [] },
      ]);
    }

    const url = (state as Record<string, unknown>).url;
    if (typeof url !== "string") {
      throw new ProviderApiError("github", "delete", [
        { message: "Cannot determine branch from state", path: [] },
      ]);
    }

    const match = url.match(
      /\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)\/protection$/,
    );
    if (match === null) {
      throw new ProviderApiError("github", "delete", [
        { message: "Cannot parse owner/repo/branch from URL", path: [] },
      ]);
    }

    await requireClient(this.client).octokit.request(
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection",
      { owner: match[1], repo: match[2], branch: match[3] } as never,
    );
  }
}
