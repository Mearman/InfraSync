import type { Client } from "@microsoft/microsoft-graph-client";
import type { ResourcePort } from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import { ProviderApiError } from "@infrasync-org/core/errors";
import * as z from "zod";
import { PROVIDER_NAME, getStateId, toProviderApiError } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface IdentitySecurityDefaultsEnforcementPolicyRefs {
  readonly id: RefToken;
  readonly isEnabled: RefToken;
}

export const buildIdentitySecurityDefaultsEnforcementPolicyRefs: RefBuilder<
  IdentitySecurityDefaultsEnforcementPolicyRefs
> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  isEnabled: new RefToken(resourceName, "isEnabled"),
});

// ─── Spec schema ─────────────────────────────────────────────────────────────

export const identitySecurityDefaultsEnforcementPolicySpecSchema =
  z.strictObject({
    kind: z.literal("IdentitySecurityDefaultsEnforcementPolicy"),
    name: z.string().trim().min(1).optional(),
    isEnabled: z.boolean(),
  });

export type IdentitySecurityDefaultsEnforcementPolicySpec = z.infer<
  typeof identitySecurityDefaultsEnforcementPolicySpecSchema
>;

// ─── State schema ────────────────────────────────────────────────────────────

const identitySecurityDefaultsEnforcementPolicyStateSchema = z
  .looseObject({
    id: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
    description: z.string().trim().optional(),
    isEnabled: z.boolean(),
  })
  .brand<"EntraIdIdentitySecurityDefaultsEnforcementPolicyState">()
  .readonly();

// ─── Identity and desired-state sub-schemas ──────────────────────────────────

const identitySchema = identitySecurityDefaultsEnforcementPolicySpecSchema.pick(
  {
    kind: true,
  },
);

const desiredStateSchema = z.object({
  isEnabled:
    identitySecurityDefaultsEnforcementPolicySpecSchema.shape.isEnabled,
});

// ─── API response validation ─────────────────────────────────────────────────

const policyResponseSchema = z.looseObject({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1).optional(),
  description: z.string().trim().optional(),
  isEnabled: z.boolean(),
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
    Object.entries(obj).filter(([, value]) => value !== undefined),
  );
}

// ─── Resource implementation ────────────────────────────────────────────────

export class IdentitySecurityDefaultsEnforcementPolicyResource implements ResourcePort<
  typeof identitySecurityDefaultsEnforcementPolicySpecSchema,
  typeof identitySecurityDefaultsEnforcementPolicyStateSchema
> {
  readonly kind = "IdentitySecurityDefaultsEnforcementPolicy";
  readonly specSchema = identitySecurityDefaultsEnforcementPolicySpecSchema;
  readonly stateSchema = identitySecurityDefaultsEnforcementPolicyStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  constructor(private readonly client: Client) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed =
      identitySecurityDefaultsEnforcementPolicySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "read", parsed.error.issues);
    }

    try {
      const raw: unknown = await this.client
        .api("/policies/identitySecurityDefaultsEnforcementPolicy")
        .get();
      return stripUndefined(validateSingle(raw, "read"));
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "read");
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed =
      identitySecurityDefaultsEnforcementPolicySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "create", parsed.error.issues);
    }

    try {
      await this.client
        .api("/policies/identitySecurityDefaultsEnforcementPolicy")
        .patch({ isEnabled: parsed.data.isEnabled });
      return await this.read(parsed.data);
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "create");
    }
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed =
      identitySecurityDefaultsEnforcementPolicySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "update", parsed.error.issues);
    }

    try {
      await this.client
        .api("/policies/identitySecurityDefaultsEnforcementPolicy")
        .patch({ isEnabled: parsed.data.isEnabled });
      return await this.read(parsed.data);
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "update");
    }
  }
}
