/**
 * Team resource for the GitHub provider.
 *
 * Manages GitHub organisation teams — create, read, update, and delete.
 *
 * @see https://docs.github.com/en/rest/teams/teams
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

export interface TeamRefs {
  readonly id: RefToken;
  readonly nodeId: RefToken;
  readonly slug: RefToken;
}

export const buildTeamRefs: RefBuilder<TeamRefs> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  nodeId: new RefToken(resourceName, "nodeId"),
  slug: new RefToken(resourceName, "slug"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const teamSpecSchema = z.object({
  kind: z.literal("Team"),
  /** Organisation the team belongs to */
  org: z.string().trim().min(1),
  /** Team name */
  name: z.string().trim().min(1),
  /** Team description */
  description: z.string().optional(),
  /** Parent team slug (for nested teams) */
  parentTeamSlug: z.string().trim().min(1).optional(),
  /** Team privacy level */
  privacy: z.enum(["secret", "closed"]).optional(),
  /** Team permission level */
  permission: z.enum(["pull", "push", "admin"]).optional(),
});

export type TeamSpec = z.infer<typeof teamSpecSchema>;

const teamStateSchema = z
  .looseObject({
    id: z.number(),
    node_id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable().optional(),
    privacy: z.string().optional(),
    permission: z.string().optional(),
    parent: z
      .looseObject({
        slug: z.string(),
      })
      .nullable()
      .optional(),
    html_url: z.string().optional(),
  })
  .brand<"GitHubTeamState">()
  .readonly();

const identitySchema = teamSpecSchema.pick({
  org: true,
  name: true,
});

const desiredStateSchema = teamSpecSchema.pick({
  description: true,
  privacy: true,
  permission: true,
  parentTeamSlug: true,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildCreateBody(
  spec: z.infer<typeof teamSpecSchema>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name };
  if (spec.description !== undefined) body.description = spec.description;
  if (spec.privacy !== undefined) body.privacy = spec.privacy;
  if (spec.permission !== undefined) body.permission = spec.permission;
  if (spec.parentTeamSlug !== undefined)
    body.parent_team_id = Number(spec.parentTeamSlug);
  return body;
}

function buildUpdateBody(
  spec: z.infer<typeof teamSpecSchema>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name };
  if (spec.description !== undefined) body.description = spec.description;
  if (spec.privacy !== undefined) body.privacy = spec.privacy;
  if (spec.permission !== undefined) body.permission = spec.permission;
  return body;
}

// ─── Resource implementation ─────────────────────────────────────────────────

export class TeamResource implements ResourcePort<
  typeof teamSpecSchema,
  typeof teamStateSchema
> {
  readonly kind = "Team";
  readonly specSchema = teamSpecSchema;
  readonly stateSchema = teamStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  constructor(
    private readonly client: GitHubClient | undefined,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      const desc = Object.getOwnPropertyDescriptor(state, "id");
      if (desc !== undefined && typeof desc.value === "number") {
        return String(desc.value);
      }
    }
    throw new Error("Invalid state: missing id");
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = teamSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "read", parsed.error.issues);
    }

    try {
      const { data } = await requireClient(this.client).octokit.request(
        "GET /orgs/{org}/teams/{team_slug}",
        { org: parsed.data.org, team_slug: parsed.data.name },
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
    const parsed = teamSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "create", parsed.error.issues);
    }

    const body = buildCreateBody(parsed.data);
    const { data } = await requireClient(this.client).octokit.request(
      "POST /orgs/{org}/teams",
      { org: parsed.data.org, ...body } as never,
    );
    return data;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = teamSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("github", "update", parsed.error.issues);
    }

    const body = buildUpdateBody(parsed.data);
    const { data } = await requireClient(this.client).octokit.request(
      "PATCH /orgs/{org}/teams/{team_slug}",
      { org: parsed.data.org, team_slug: parsed.data.name, ...body } as never,
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
    const slug = s.slug;
    const owner = this.extractOrgFromState(s);

    if (owner === undefined || typeof slug !== "string") {
      throw new ProviderApiError("github", "delete", [
        { message: "Cannot determine org/slug from state", path: [] },
      ]);
    }

    await requireClient(this.client).octokit.request(
      "DELETE /orgs/{org}/teams/{team_slug}",
      { org: owner, team_slug: slug } as never,
    );
  }

  private extractOrgFromState(s: Record<string, unknown>): string | undefined {
    // The html_url format for teams is: https://github.com/orgs/{org}/teams/{slug}
    const url = s.html_url;
    if (typeof url === "string") {
      const match = url.match(/\/orgs\/([^/]+)\/teams\//);
      if (match !== null) return match[1];
    }
    return undefined;
  }
}
