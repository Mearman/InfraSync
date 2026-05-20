import type { Client } from "@microsoft/microsoft-graph-client";
import type { ResourcePort } from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import { ProviderApiError } from "@infrasync/core/errors";
import * as z from "zod";
import { PROVIDER_NAME, getStateId, toProviderApiError } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface FeatureRolloutPolicyRefs {
  readonly id: RefToken;
  readonly displayName: RefToken;
  readonly feature: RefToken;
}

export const buildFeatureRolloutPolicyRefs: RefBuilder<
  FeatureRolloutPolicyRefs
> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  displayName: new RefToken(resourceName, "displayName"),
  feature: new RefToken(resourceName, "feature"),
});

// ─── Spec schema ─────────────────────────────────────────────────────────────

export const featureRolloutPolicySpecSchema = z.strictObject({
  kind: z.literal("FeatureRolloutPolicy"),
  name: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1),
  description: z.string().trim().optional(),
  feature: z.enum([
    "passwordHashSync",
    "passthroughAuthentication",
    "seamlessSso",
    "passwordWriteback",
  ]),
  isEnabled: z.boolean().default(true),
  isAppliedToOrganization: z.boolean().default(false),
  appliesToUserIds: z.array(z.string().trim().min(1)).default([]),
});

export type FeatureRolloutPolicySpec = z.infer<
  typeof featureRolloutPolicySpecSchema
>;

// ─── State schema ────────────────────────────────────────────────────────────

/**
 * Provider-returned state for an Entra ID feature rollout policy.
 *
 * Member management (`appliesToUserIds`) is handled separately via the
 * `appliesTo` sub-resource and is not part of the convergence state.
 */
const featureRolloutPolicyStateSchema = z
  .looseObject({
    id: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    description: z.string().trim().optional(),
    feature: z.string().trim().min(1),
    isEnabled: z.boolean(),
    isAppliedToOrganization: z.boolean(),
  })
  .brand<"EntraIdFeatureRolloutPolicyState">()
  .readonly();

// ─── Identity and desired-state sub-schemas ──────────────────────────────────

const featureRolloutPolicyIdentitySchema = featureRolloutPolicySpecSchema.pick({
  kind: true,
  displayName: true,
  feature: true,
});

/**
 * Convergence schema — picks only the mutable, diffable fields.
 *
 * `kind`, `displayName`, and `feature` are identity fields. `appliesToUserIds`
 * is managed via the `appliesTo` sub-resource, not diffed as part of policy
 * state. `name` is engine-injected and not a Graph API field.
 *
 * Rebuilt as a `z.object` (loose) — `featureRolloutPolicySpecSchema` is a
 * `z.strictObject` so `.pick()` would propagate strict-mode and reject extra
 * fields the engine passes through in `resolvedSpec`. The spread-from-shape
 * idiom changes strictness while preserving each field's exact validator.
 */
const featureRolloutPolicyDesiredStateSchema = z.object({
  description: featureRolloutPolicySpecSchema.shape.description,
  isEnabled: featureRolloutPolicySpecSchema.shape.isEnabled,
  isAppliedToOrganization:
    featureRolloutPolicySpecSchema.shape.isAppliedToOrganization,
});

// ─── API response validation ─────────────────────────────────────────────────

/**
 * Validates a single policy entry from the Graph API.
 *
 * `description` is optional: Graph omits the key entirely when no description
 * has been set. The `nullish().transform()` pattern normalises null → undefined
 * so the state object never carries `{ description: null }`.
 */
const policyResponseSchema = z.looseObject({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  description: z
    .string()
    .trim()
    .nullish()
    .transform((v) => v ?? undefined),
  feature: z.string().trim().min(1),
  isEnabled: z.boolean(),
  isAppliedToOrganization: z.boolean(),
});

/**
 * Validates the collection envelope returned by
 * `GET /policies/featureRolloutPolicies`.
 */
const collectionResponseSchema = z.looseObject({
  value: z.array(policyResponseSchema),
});

/**
 * Validates the collection envelope returned by
 * `GET /policies/featureRolloutPolicies/{id}/appliesTo`.
 */
const appliesToCollectionSchema = z.looseObject({
  value: z.array(z.looseObject({ id: z.string().trim().min(1) })),
});

function validateSingle(
  raw: unknown,
  operation: string,
): z.infer<typeof policyResponseSchema> {
  const result = policyResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new ProviderApiError(PROVIDER_NAME, operation, result.error.issues);
  }
  return result.data;
}

function stripUndefined(
  obj: z.infer<typeof policyResponseSchema>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  );
}

// ─── Request body builders ───────────────────────────────────────────────────

/**
 * Build the body for `POST /policies/featureRolloutPolicies`.
 * `appliesToUserIds` is not included — members are managed via the
 * `appliesTo` sub-resource after creation.
 */
function buildCreateBody(
  spec: FeatureRolloutPolicySpec,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    displayName: spec.displayName,
    feature: spec.feature,
    isEnabled: spec.isEnabled,
    isAppliedToOrganization: spec.isAppliedToOrganization,
  };
  if (spec.description !== undefined) {
    body.description = spec.description;
  }
  return body;
}

/**
 * Build the body for `PATCH /policies/featureRolloutPolicies/{id}`.
 * Only mutable, non-identity fields are included.
 */
function buildUpdateBody(
  spec: FeatureRolloutPolicySpec,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    isEnabled: spec.isEnabled,
    isAppliedToOrganization: spec.isAppliedToOrganization,
  };
  if (spec.description !== undefined) {
    body.description = spec.description;
  }
  return body;
}

// ─── Member sync helper ───────────────────────────────────────────────────────

/**
 * Fetch the current members of a feature rollout policy's `appliesTo` list
 * and reconcile them against the desired set of user object IDs.
 *
 * Members absent from `desired` are removed; members absent from `current`
 * are added. The function issues the minimum number of API calls required to
 * reach the desired state.
 */
async function syncMembers(
  policyId: string,
  desired: readonly string[],
  client: Client,
  operation: string,
): Promise<void> {
  // Fetch current members
  const rawMembers: unknown = await client
    .api(
      `/policies/featureRolloutPolicies/${encodeURIComponent(policyId)}/appliesTo`,
    )
    .get();

  const parsed = appliesToCollectionSchema.safeParse(rawMembers);
  if (!parsed.success) {
    throw new ProviderApiError(PROVIDER_NAME, operation, parsed.error.issues);
  }

  const currentIds = new Set(parsed.data.value.map((m) => m.id));
  const desiredIds = new Set(desired);

  // Add members not yet present
  const toAdd = [...desiredIds].filter((id) => !currentIds.has(id));
  // Remove members no longer desired
  const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));

  await Promise.all([
    ...toAdd.map((userId) =>
      client
        .api(
          `/policies/featureRolloutPolicies/${encodeURIComponent(policyId)}/appliesTo/$ref`,
        )
        .post({
          "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`,
        }),
    ),
    ...toRemove.map((userId) =>
      client
        .api(
          `/policies/featureRolloutPolicies/${encodeURIComponent(policyId)}/appliesTo/${encodeURIComponent(userId)}/$ref`,
        )
        .delete(),
    ),
  ]);
}

// ─── Resource implementation ────────────────────────────────────────────────

export class FeatureRolloutPolicyResource implements ResourcePort<
  typeof featureRolloutPolicySpecSchema,
  typeof featureRolloutPolicyStateSchema
> {
  readonly kind = "FeatureRolloutPolicy";
  readonly specSchema = featureRolloutPolicySpecSchema;
  readonly stateSchema = featureRolloutPolicyStateSchema;
  readonly identitySchema = featureRolloutPolicyIdentitySchema;
  readonly desiredStateSchema = featureRolloutPolicyDesiredStateSchema;

  constructor(private readonly client: Client) {}

  getStateId = getStateId;

  /**
   * Find a policy by `displayName` + `feature` from the collection endpoint
   * and return its validated state, or `undefined` if no match is found.
   *
   * The collection endpoint (`GET /policies/featureRolloutPolicies`) returns
   * the full policy document — no follow-up GET per item is required.
   */
  async read(spec: unknown): Promise<unknown> {
    const parsed = featureRolloutPolicySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "read", parsed.error.issues);
    }
    try {
      const rawCollection: unknown = await this.client
        .api("/policies/featureRolloutPolicies")
        .get();

      const collection = collectionResponseSchema.safeParse(rawCollection);
      if (!collection.success) {
        throw new ProviderApiError(
          PROVIDER_NAME,
          "read",
          collection.error.issues,
        );
      }

      const match = collection.data.value.find(
        (p) =>
          p.displayName === parsed.data.displayName &&
          p.feature === parsed.data.feature,
      );
      if (match === undefined) return undefined;
      return stripUndefined(match);
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "read");
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = featureRolloutPolicySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "create", parsed.error.issues);
    }
    try {
      const raw: unknown = await this.client
        .api("/policies/featureRolloutPolicies")
        .post(buildCreateBody(parsed.data));

      // POST returns the created resource — validate and extract id.
      const created = validateSingle(raw, "create");

      // Sync membership to the desired set.
      await syncMembers(
        created.id,
        parsed.data.appliesToUserIds,
        this.client,
        "create",
      );

      return stripUndefined(created);
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "create");
    }
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = featureRolloutPolicySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "update", parsed.error.issues);
    }
    try {
      await this.client
        .api(`/policies/featureRolloutPolicies/${encodeURIComponent(id)}`)
        .patch(buildUpdateBody(parsed.data));

      // Sync membership against the desired set.
      await syncMembers(
        id,
        parsed.data.appliesToUserIds,
        this.client,
        "update",
      );

      // PATCH returns 204 No Content — re-read for canonical state.
      const rawCollection: unknown = await this.client
        .api("/policies/featureRolloutPolicies")
        .get();

      const collection = collectionResponseSchema.safeParse(rawCollection);
      if (!collection.success) {
        throw new ProviderApiError(
          PROVIDER_NAME,
          "update",
          collection.error.issues,
        );
      }

      const match = collection.data.value.find((p) => p.id === id);
      if (match === undefined) {
        throw new ProviderApiError(PROVIDER_NAME, "update", [
          {
            path: ["id"],
            message: `Feature rollout policy '${id}' not found after update`,
          },
        ]);
      }

      return stripUndefined(match);
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "update");
    }
  }
}
