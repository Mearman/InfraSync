/**
 * Repository resource for the GitHub provider.
 *
 * Manages GitHub repositories — create, read, update, and delete via the
 * Octokit REST API.
 *
 * @see https://docs.github.com/en/rest/repos/repos
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

export interface RepositoryRefs {
  readonly id: RefToken;
  readonly nodeId: RefToken;
}

export const buildRepositoryRefs: RefBuilder<RepositoryRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  nodeId: new RefToken(resourceName, "nodeId"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const repositorySpecSchema = z.object({
  kind: z.literal("Repository"),
  /** Repository owner (user or organisation) */
  owner: z.string().trim().min(1),
  /** Repository name */
  name: z.string().trim().min(1),
  /** Repository description */
  description: z.string().optional(),
  /** Whether the repository is private */
  private: z.boolean().optional(),
  /** Whether issues are enabled */
  hasIssues: z.boolean().optional(),
  /** Whether projects are enabled */
  hasProjects: z.boolean().optional(),
  /** Whether the wiki is enabled */
  hasWiki: z.boolean().optional(),
  /** Whether squash-merge is enabled */
  allowSquashMerge: z.boolean().optional(),
  /** Whether merge commits are enabled */
  allowMergeCommit: z.boolean().optional(),
  /** Whether rebase merge is enabled */
  allowRebaseMerge: z.boolean().optional(),
  /** Whether auto-merge is enabled */
  allowAutoMerge: z.boolean().optional(),
  /** Whether delete-branch-on-merge is enabled */
  deleteBranchOnMerge: z.boolean().optional(),
  /** Default branch name */
  defaultBranch: z.string().trim().min(1).optional(),
  /** Homepage URL */
  homepage: z.string().trim().min(1).optional(),
  /** Whether the repository is a template */
  isTemplate: z.boolean().optional(),
  /** List of topic names */
  topics: z.array(z.string().trim().min(1)).optional(),
  /** Visibility: public, private, or internal */
  visibility: z.enum(["public", "private", "internal"]).optional(),
});

export type RepositorySpec = z.infer<typeof repositorySpecSchema>;

const repositoryStateSchema = z
  .looseObject({
    id: z.number(),
    node_id: z.string(),
    name: z.string(),
    full_name: z.string(),
    owner: z
      .looseObject({
        login: z.string(),
      })
      .optional(),
    private: z.boolean().optional(),
    description: z.string().nullable().optional(),
    has_issues: z.boolean().optional(),
    has_projects: z.boolean().optional(),
    has_wiki: z.boolean().optional(),
    allow_squash_merge: z.boolean().optional(),
    allow_merge_commit: z.boolean().optional(),
    allow_rebase_merge: z.boolean().optional(),
    allow_auto_merge: z.boolean().optional(),
    delete_branch_on_merge: z.boolean().optional(),
    default_branch: z.string().optional(),
    homepage: z.string().nullable().optional(),
    is_template: z.boolean().optional(),
    topics: z.array(z.string()).optional(),
    visibility: z.string().optional(),
    html_url: z.string().optional(),
  })
  .brand<"GitHubRepositoryState">()
  .readonly();

const identitySchema = repositorySpecSchema.pick({
  owner: true,
  name: true,
});

const desiredStateSchema = repositorySpecSchema.pick({
  description: true,
  private: true,
  hasIssues: true,
  hasProjects: true,
  hasWiki: true,
  allowSquashMerge: true,
  allowMergeCommit: true,
  allowRebaseMerge: true,
  allowAutoMerge: true,
  deleteBranchOnMerge: true,
  defaultBranch: true,
  homepage: true,
  isTemplate: true,
  topics: true,
  visibility: true,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a request body from spec, mapping camelCase to snake_case and
 * omitting undefined values. Uses octokit.request() to avoid
 * exactOptionalPropertyTypes friction with the typed endpoint methods.
 */
function buildCreateRequest(
  spec: z.infer<typeof repositorySpecSchema>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name };
  if (spec.description !== undefined) body.description = spec.description;
  if (spec.private !== undefined) body.private = spec.private;
  if (spec.hasIssues !== undefined) body.has_issues = spec.hasIssues;
  if (spec.hasProjects !== undefined) body.has_projects = spec.hasProjects;
  if (spec.hasWiki !== undefined) body.has_wiki = spec.hasWiki;
  if (spec.allowSquashMerge !== undefined)
    body.allow_squash_merge = spec.allowSquashMerge;
  if (spec.allowMergeCommit !== undefined)
    body.allow_merge_commit = spec.allowMergeCommit;
  if (spec.allowRebaseMerge !== undefined)
    body.allow_rebase_merge = spec.allowRebaseMerge;
  if (spec.allowAutoMerge !== undefined)
    body.allow_auto_merge = spec.allowAutoMerge;
  if (spec.deleteBranchOnMerge !== undefined)
    body.delete_branch_on_merge = spec.deleteBranchOnMerge;
  if (spec.homepage !== undefined) body.homepage = spec.homepage;
  if (spec.isTemplate !== undefined) body.is_template = spec.isTemplate;
  if (spec.visibility !== undefined) body.visibility = spec.visibility;
  return body;
}

function buildUpdateRequest(
  spec: z.infer<typeof repositorySpecSchema>,
): Record<string, unknown> {
  const body = buildCreateRequest(spec);
  if (spec.defaultBranch !== undefined)
    body.default_branch = spec.defaultBranch;
  if (spec.topics !== undefined) body.topics = spec.topics;
  return body;
}

// ─── Resource implementation ─────────────────────────────────────────────────

export class RepositoryResource implements ResourcePort<
  typeof repositorySpecSchema,
  typeof repositoryStateSchema
> {
  readonly kind = "Repository";
  readonly specSchema = repositorySpecSchema;
  readonly stateSchema = repositoryStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  constructor(
    private readonly client: GitHubClient | undefined,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "full_name" in state) {
      const desc = Object.getOwnPropertyDescriptor(state, "full_name");
      if (desc !== undefined && typeof desc.value === "string") {
        return desc.value;
      }
    }
    // Fall back to owner/name combination
    if (typeof state === "object" && state !== null) {
      const s = state as Record<string, unknown>;
      const owner =
        typeof s.owner === "object" && s.owner !== null
          ? (s.owner as { login?: string }).login
          : undefined;
      const name = s.name;
      if (typeof owner === "string" && typeof name === "string") {
        return `${owner}/${name}`;
      }
    }
    throw new Error("Invalid state: missing full_name or owner/name");
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = repositorySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "read", parsed.error.issues);
    }

    try {
      const { data } = await requireClient(this.client).octokit.request(
        "GET /repos/{owner}/{repo}",
        { owner: parsed.data.owner, repo: parsed.data.name },
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
    const parsed = repositorySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "create", parsed.error.issues);
    }

    const body = buildCreateRequest(parsed.data);
    const { data } = await requireClient(this.client).octokit.request(
      "POST /orgs/{org}/repos",
      { org: parsed.data.owner, ...body } as never,
    );
    return data;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = repositorySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "update", parsed.error.issues);
    }

    const body = buildUpdateRequest(parsed.data);
    const [owner, repo] = id.split("/", 2);
    const { data } = await requireClient(this.client).octokit.request(
      "PATCH /repos/{owner}/{repo}",
      { owner, repo, ...body } as never,
    );
    return data;
  }

  async delete(state: unknown): Promise<void> {
    if (typeof state !== "object" || state === null) {
      throw new ProviderApiError("github", "delete", [
        { message: "Invalid state for delete", path: [] },
      ]);
    }
    const s = state as Record<string, unknown>;
    const owner =
      typeof s.owner === "object" && s.owner !== null
        ? (s.owner as { login?: string }).login
        : undefined;
    const name = s.name;

    if (owner === undefined || typeof name !== "string") {
      throw new ProviderApiError("github", "delete", [
        { message: "Cannot determine owner/name from state", path: [] },
      ]);
    }

    await requireClient(this.client).octokit.request(
      "DELETE /repos/{owner}/{repo}",
      { owner, repo: name } as never,
    );
  }
}
