/**
 * UserCustomAttribute — a single custom attribute value on a Google Workspace
 * user profile.
 *
 * Ensures a specified `customSchemas.{schemaName}.{fieldName}` value is set on
 * the user. If the value differs, patches the user to update it. If the
 * attribute is absent, patches the user to add it.
 *
 * This is the complement to `DirectorySchema`: the schema defines the field
 * *type*, and this resource populates the field *value* per user. Together
 * they enable patterns like storing a stable immutable ID on each user for
 * SAML NameID matching.
 *
 * Wraps the `users.patch` REST surface with `customSchemas` in the body.
 *
 * @see https://developers.google.com/workspace/admin/directory/v1/reference/users/patch
 */

import * as z from "zod";
import type { ResourcePort } from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import { ProviderApiError } from "@infrasync-org/core/errors";
import type { DirectoryClient } from "./client.js";
import { PROVIDER_NAME, isNotFound, toProviderApiError } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface UserCustomAttributeRefs {
  readonly value: RefToken;
}

export const buildUserCustomAttributeRefs: RefBuilder<
  UserCustomAttributeRefs
> = (resourceName) => ({
  value: new RefToken(resourceName, "value"),
});

// ─── Spec schema ─────────────────────────────────────────────────────────────

export const userCustomAttributeSpecSchema = z.strictObject({
  kind: z.literal("UserCustomAttribute"),
  /** The user's primary email — used as the user key in the API. */
  primaryEmail: z.email(),
  /** The custom schema name (e.g. "microsoftEntra"). */
  schemaName: z.string().trim().min(1),
  /** The field name within the schema (e.g. "immutableId"). */
  fieldName: z.string().trim().min(1),
  /** The desired value for this attribute (always a string). */
  value: z.string().trim().min(1),
});

export type UserCustomAttributeSpec = z.infer<
  typeof userCustomAttributeSpecSchema
>;

// ─── State schema ────────────────────────────────────────────────────────────

const userCustomAttributeStateSchema = z
  .looseObject({
    primaryEmail: z.email(),
    schemaName: z.string().trim().min(1),
    fieldName: z.string().trim().min(1),
    value: z.string().trim().min(1),
  })
  .readonly();

// ─── Identity and desired-state sub-schemas ──────────────────────────────────

const userCustomAttributeIdentitySchema = z.strictObject({
  kind: z.literal("UserCustomAttribute"),
  primaryEmail: userCustomAttributeSpecSchema.shape.primaryEmail,
  schemaName: userCustomAttributeSpecSchema.shape.schemaName,
  fieldName: userCustomAttributeSpecSchema.shape.fieldName,
});

const userCustomAttributeDesiredStateSchema = z.object({
  value: userCustomAttributeSpecSchema.shape.value,
});

// ─── API response validation ─────────────────────────────────────────────────

const userResponseSchema = z.looseObject({
  primaryEmail: z.email().optional(),
  customSchemas: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Extract the current value of a custom attribute from a user API response.
 * Returns `undefined` if the schema or field is absent.
 */
function extractCustomAttributeValue(
  user: z.infer<typeof userResponseSchema>,
  schemaName: string,
  fieldName: string,
): string | undefined {
  if (user.customSchemas === undefined) return undefined;
  const schema = user.customSchemas[schemaName];
  if (typeof schema !== "object" || schema === null) return undefined;
  if (!(fieldName in schema)) return undefined;
  // After `in` narrowing, we still need bracket access on a generic `object`.
  // TypeScript's `object` has no index signature, so we read via Object.getOwnPropertyDescriptor
  // to avoid a type assertion.
  const descriptor = Object.getOwnPropertyDescriptor(schema, fieldName);
  if (descriptor === undefined) return undefined;
  const raw: unknown = descriptor.value;
  if (typeof raw === "string") return raw;
  // Multi-valued fields come as arrays — not supported for this resource
  return undefined;
}

// ─── Resource implementation ────────────────────────────────────────────────

export class UserCustomAttributeResource implements ResourcePort<
  typeof userCustomAttributeSpecSchema,
  typeof userCustomAttributeStateSchema
> {
  readonly kind = "UserCustomAttribute";
  readonly specSchema = userCustomAttributeSpecSchema;
  readonly stateSchema = userCustomAttributeStateSchema;
  readonly identitySchema = userCustomAttributeIdentitySchema;
  readonly desiredStateSchema = userCustomAttributeDesiredStateSchema;

  constructor(private readonly client: DirectoryClient | undefined) {}

  getStateId(state: unknown): string {
    if (
      typeof state === "object" &&
      state !== null &&
      "primaryEmail" in state &&
      "schemaName" in state &&
      "fieldName" in state
    ) {
      const pe = state.primaryEmail;
      const sn = state.schemaName;
      const fn = state.fieldName;
      if (
        typeof pe === "string" &&
        typeof sn === "string" &&
        typeof fn === "string"
      ) {
        return `${pe}#${sn}#${fn}`;
      }
    }
    throw new ProviderApiError(PROVIDER_NAME, "getStateId", [
      {
        path: [],
        message:
          "State object does not contain valid primaryEmail/schemaName/fieldName fields",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = userCustomAttributeSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "read", parsed.error.issues);
    }

    if (this.client === undefined) {
      throw new ProviderApiError(PROVIDER_NAME, "read", [
        { path: [], message: "Google Workspace provider not connected" },
      ]);
    }

    try {
      const raw = await this.client.getUser(parsed.data.primaryEmail);
      const userResult = userResponseSchema.safeParse(raw);
      if (!userResult.success) {
        throw new ProviderApiError(
          PROVIDER_NAME,
          "read",
          userResult.error.issues,
        );
      }

      const currentValue = extractCustomAttributeValue(
        userResult.data,
        parsed.data.schemaName,
        parsed.data.fieldName,
      );

      if (currentValue === undefined) return undefined;

      return {
        primaryEmail: parsed.data.primaryEmail,
        schemaName: parsed.data.schemaName,
        fieldName: parsed.data.fieldName,
        value: currentValue,
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "read");
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = userCustomAttributeSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "create", parsed.error.issues);
    }

    if (this.client === undefined) {
      throw new ProviderApiError(PROVIDER_NAME, "create", [
        { path: [], message: "Google Workspace provider not connected" },
      ]);
    }

    return this.enforceAttribute(parsed.data, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = userCustomAttributeSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "update", parsed.error.issues);
    }

    if (this.client === undefined) {
      throw new ProviderApiError(PROVIDER_NAME, "update", [
        { path: [], message: "Google Workspace provider not connected" },
      ]);
    }

    return this.enforceAttribute(parsed.data, "update");
  }

  /**
   * Set the custom attribute on the user via PATCH, then re-read to confirm.
   * Used by both `create` (attribute absent) and `update` (value differs).
   */
  private async enforceAttribute(
    spec: UserCustomAttributeSpec,
    operation: string,
  ): Promise<unknown> {
    if (this.client === undefined) {
      throw new ProviderApiError(PROVIDER_NAME, operation, [
        { path: [], message: "Google Workspace provider not connected" },
      ]);
    }

    const body = {
      customSchemas: {
        [spec.schemaName]: {
          [spec.fieldName]: spec.value,
        },
      },
    };

    try {
      await this.client.patchUser(spec.primaryEmail, body);

      // Re-read to confirm the value was set
      const raw = await this.client.getUser(spec.primaryEmail);
      const userResult = userResponseSchema.safeParse(raw);
      if (!userResult.success) {
        throw new ProviderApiError(
          PROVIDER_NAME,
          operation,
          userResult.error.issues,
        );
      }

      const confirmedValue = extractCustomAttributeValue(
        userResult.data,
        spec.schemaName,
        spec.fieldName,
      );

      if (confirmedValue === undefined) {
        throw new ProviderApiError(PROVIDER_NAME, operation, [
          {
            path: ["customSchemas", spec.schemaName, spec.fieldName],
            message: `Attribute ${spec.schemaName}.${spec.fieldName} was not set after PATCH`,
          },
        ]);
      }

      return {
        primaryEmail: spec.primaryEmail,
        schemaName: spec.schemaName,
        fieldName: spec.fieldName,
        value: confirmedValue,
      };
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, operation);
    }
  }
}
