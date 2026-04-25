import Cloudflare from "cloudflare";
import type {
  PolicyCreateParams,
  PolicyUpdateParams,
} from "cloudflare/resources/zero-trust/access/policies.js";
import type { ResourcePort } from "../../core/provider.js";
import { RefToken, refable } from "../../core/refs.js";
import type { RefBuilder } from "../../authoring/handles.js";
import * as z from "zod";
import { ProviderApiError } from "../../core/errors.js";
import { getStateId } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface AccessPolicyRefs {
  readonly id: RefToken;
  readonly name: RefToken;
}

export const buildAccessPolicyRefs: RefBuilder<AccessPolicyRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Access rule array schema.
 *
 * The Cloudflare SDK models access rules as a large discriminated union
 * (`AccessRuleParam`) with dozens of specific rule types. Our spec accepts
 * arbitrary objects — users pass whatever their policy needs. We validate
 * that the value is an array of plain objects but don't enforce the SDK's
 * full union at the schema level. The SDK itself validates at the API boundary.
 */
const accessRuleArraySchema = z.array(z.json());

export const accessPolicySpecSchema = z.object({
  kind: z.literal("AccessPolicy"),
  /** The Access Application ID this policy belongs to (for listing) */
  applicationId: refable(z.string().trim().min(1)),
  name: z.string().trim().min(1),
  decision: z.enum(["allow", "deny", "non_identity", "bypass"]),
  include: accessRuleArraySchema,
  exclude: accessRuleArraySchema.optional(),
  require: accessRuleArraySchema.optional(),
});

export type AccessPolicySpec = z.infer<typeof accessPolicySpecSchema>;

/**
 * Schema for the resolved spec after ref resolution.
 * By the time we call the Cloudflare SDK, all RefTokens have been replaced
 * with concrete values. This schema strips the refable union from
 * applicationId so the adapter gets a plain string.
 */
const resolvedSpecSchema = z.object({
  kind: z.literal("AccessPolicy"),
  applicationId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  decision: z.enum(["allow", "deny", "non_identity", "bypass"]),
  include: accessRuleArraySchema,
  exclude: accessRuleArraySchema.optional(),
  require: accessRuleArraySchema.optional(),
});

const accessPolicyStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    decision: z.string().trim(),
    include: z.array(z.json()),
    exclude: z.array(z.json()).optional(),
    require: z.array(z.json()).optional(),
    created_at: z.string().trim().optional(),
    updated_at: z.string().trim().optional(),
  })
  .brand<"CloudflareAccessPolicyState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  name: z.string().trim(),
  decision: z.string().trim(),
  include: z.array(z.json()),
  exclude: z.array(z.json()).optional(),
  require: z.array(z.json()).optional(),
  created_at: z.string().trim().optional(),
  updated_at: z.string().trim().optional(),
});

const identitySchema = accessPolicySpecSchema.pick({
  applicationId: true,
  name: true,
});

const desiredStateSchema = accessPolicySpecSchema.pick({
  decision: true,
  include: true,
  exclude: true,
  require: true,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateApiResponse(
  raw: unknown,
  operation: string,
): z.infer<typeof apiResponseSchema> {
  const result = apiResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new ProviderApiError("cloudflare", operation, result.error.issues);
  }
  return result.data;
}

/**
 * Build SDK-typed create params from our validated spec.
 *
 * Uses the account-level policies API which accepts `name`, `decision`,
 * `include`, `exclude`, `require`. The `precedence` field is only available
 * on the application-scoped policies API and is not currently supported.
 *
 * The spec uses `Record<string, unknown>` for rule arrays, but the SDK
 * expects `AccessRuleParam[]`. Since we validate shape through Zod and the
 * SDK validates at the API boundary, we bridge via the SDK rule type.
 */
function buildCreateParams(
  accountId: string,
  name: string,
  decision: "allow" | "deny" | "non_identity" | "bypass",
  include: readonly unknown[],
  exclude: readonly unknown[] | undefined,
  require: readonly unknown[] | undefined,
): PolicyCreateParams {
  // Build the base params that TypeScript can verify
  const params: PolicyCreateParams = {
    account_id: accountId,
    name,
    decision,
    // AccessRuleParam is a deep union that our Zod schema can't produce.
    // Structurally correct at runtime; SDK validates at the API boundary.
    include: Object.assign([], [...include]),
  };
  if (exclude !== undefined) {
    params.exclude = Object.assign([], [...exclude]);
  }
  if (require !== undefined) {
    params.require = Object.assign([], [...require]);
  }
  return params;
}

function buildUpdateParams(
  accountId: string,
  name: string,
  decision: "allow" | "deny" | "non_identity" | "bypass",
  include: readonly unknown[],
  exclude: readonly unknown[] | undefined,
  require: readonly unknown[] | undefined,
): PolicyUpdateParams {
  const params: PolicyUpdateParams = {
    account_id: accountId,
    name,
    decision,
    include: Object.assign([], [...include]),
  };
  if (exclude !== undefined) {
    params.exclude = Object.assign([], [...exclude]);
  }
  if (require !== undefined) {
    params.require = Object.assign([], [...require]);
  }
  return params;
}

// ─── Resource implementation ─────────────────────────────────────────────────

export class AccessPolicyResource implements ResourcePort<
  typeof accessPolicySpecSchema,
  typeof accessPolicyStateSchema
> {
  readonly kind = "AccessPolicy";
  readonly specSchema = accessPolicySpecSchema;
  readonly stateSchema = accessPolicyStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  constructor(
    private readonly client: Cloudflare,
    private readonly accountId: string,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    // Use the application-scoped policies list to find policies for this application
    const policies =
      await this.client.zeroTrust.access.applications.policies.list(
        parsed.data.applicationId,
        { account_id: this.accountId },
      );
    const match = policies.result.find((p) => {
      if ("name" in p && typeof p.name === "string") {
        return p.name === parsed.data.name;
      }
      return false;
    });
    if (match === undefined) return undefined;
    return validateApiResponse(match, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }
    const { name, decision, include, exclude, require } = parsed.data;

    const params = buildCreateParams(
      this.accountId,
      name,
      decision,
      include,
      exclude,
      require,
    );
    const response = await this.client.zeroTrust.access.policies.create(params);

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }
    const { name, decision, include, exclude, require } = parsed.data;

    const params = buildUpdateParams(
      this.accountId,
      name,
      decision,
      include,
      exclude,
      require,
    );
    const response = await this.client.zeroTrust.access.policies.update(
      id,
      params,
    );

    return validateApiResponse(response, "update");
  }
}
