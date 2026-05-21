/**
 * DirectorySchema — Google Admin Directory custom user schema.
 *
 * Manages a custom attribute schema that defines additional fields on user
 * profiles. Custom schemas are required when SAML apps need to send
 * non-standard attributes (e.g. a stable immutable ID) in the assertion
 * instead of the user's primary email.
 *
 * Wraps the `schemas` REST surface
 * (https://developers.google.com/workspace/admin/directory/v1/reference/schemas).
 *
 * The schema name is the identity key — there can only be one schema per
 * name per customer. Field definitions within the schema are mutable via
 * PUT (full replacement).
 */

import * as z from "zod";
import type { ResourcePort } from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import { ProviderApiError } from "@infrasync-org/core/errors";
import type { DirectoryClient } from "./client.js";
import { PROVIDER_NAME, isNotFound, toProviderApiError } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface DirectorySchemaRefs {
  readonly schemaId: RefToken;
  readonly schemaName: RefToken;
}

export const buildDirectorySchemaRefs: RefBuilder<DirectorySchemaRefs> = (
  resourceName,
) => ({
  schemaId: new RefToken(resourceName, "schemaId"),
  schemaName: new RefToken(resourceName, "schemaName"),
});

// ─── Schema field schema ─────────────────────────────────────────────────────

/**
 * A single field definition within a custom schema.
 *
 * Matches the Google API's SchemaFieldSpec shape:
 * https://developers.google.com/workspace/admin/directory/v1/reference/schemas#resource-schema
 */
const schemaFieldSpecSchema = z.strictObject({
  fieldName: z.string().trim().min(1),
  fieldType: z.enum([
    "BOOL",
    "DATE",
    "DOUBLE",
    "EMAIL",
    "INT64",
    "PHONE",
    "STRING",
  ]),
  multiValued: z.boolean().default(false),
  readAccessType: z
    .enum(["ALL_USERS", "ADMINS_AND_SELF"])
    .default("ADMINS_AND_SELF"),
});

export type SchemaFieldSpec = z.infer<typeof schemaFieldSpecSchema>;

// ─── Spec schema ─────────────────────────────────────────────────────────────

export const directorySchemaSpecSchema = z.strictObject({
  kind: z.literal("DirectorySchema"),
  schemaName: z.string().trim().min(1),
  fields: z.array(schemaFieldSpecSchema).min(1),
});

export type DirectorySchemaSpec = z.infer<typeof directorySchemaSpecSchema>;

// ─── State schema ────────────────────────────────────────────────────────────

const directorySchemaStateSchema = z
  .looseObject({
    schemaId: z.string().trim().min(1),
    schemaName: z.string().trim().min(1),
    fields: z.array(
      z.looseObject({
        fieldName: z.string().trim().min(1),
        fieldType: z.string().trim().min(1),
        multiValued: z.boolean().optional(),
        readAccessType: z.string().trim().optional(),
        fieldId: z.string().trim().optional(),
      }),
    ),
  })
  .readonly();

// ─── Identity and desired-state sub-schemas ──────────────────────────────────

const directorySchemaIdentitySchema = directorySchemaSpecSchema.pick({
  kind: true,
  schemaName: true,
});

/**
 * Convergence schema — compares only the mutable, diffable fields.
 *
 * `kind` and `schemaName` are identity fields; they cannot change between
 * desired and actual without meaning a different resource entirely.
 */
const directorySchemaDesiredStateSchema = z.object({
  fields: z.array(
    z.object({
      fieldName: schemaFieldSpecSchema.shape.fieldName,
      fieldType: schemaFieldSpecSchema.shape.fieldType,
      multiValued: schemaFieldSpecSchema.shape.multiValued,
      readAccessType: schemaFieldSpecSchema.shape.readAccessType,
    }),
  ),
});

// ─── API response validation ─────────────────────────────────────────────────

const schemaResponseSchema = z.looseObject({
  schemaId: z.string().trim().min(1),
  schemaName: z.string().trim().min(1),
  fields: z.array(z.unknown()),
});

const schemaListResponseSchema = z.looseObject({
  schemas: z.array(z.unknown()).optional(),
});

function validateSchemaResponse(
  raw: unknown,
  operation: string,
): z.infer<typeof directorySchemaStateSchema> {
  // First validate envelope
  const envelopeResult = schemaResponseSchema.safeParse(raw);
  if (!envelopeResult.success) {
    throw new ProviderApiError(
      PROVIDER_NAME,
      operation,
      envelopeResult.error.issues,
    );
  }

  // Then validate individual fields loosely
  const fieldElementSchema = z.looseObject({
    fieldName: z.string().trim().min(1),
    fieldType: z.string().trim().min(1),
    multiValued: z.boolean().optional(),
    readAccessType: z.string().trim().optional(),
    fieldId: z.string().trim().optional(),
  });

  const fieldResults = envelopeResult.data.fields.map((field) => {
    const result = fieldElementSchema.safeParse(field);
    if (!result.success) {
      throw new ProviderApiError(PROVIDER_NAME, operation, result.error.issues);
    }
    return result.data;
  });

  return {
    schemaId: envelopeResult.data.schemaId,
    schemaName: envelopeResult.data.schemaName,
    fields: fieldResults,
  };
}

// ─── Request body builder ────────────────────────────────────────────────────

function buildSchemaBody(spec: DirectorySchemaSpec): Record<string, unknown> {
  return {
    schemaName: spec.schemaName,
    fields: spec.fields.map((field) => ({
      fieldName: field.fieldName,
      fieldType: field.fieldType,
      multiValued: field.multiValued,
      readAccessType: field.readAccessType,
    })),
  };
}

// ─── Resource implementation ────────────────────────────────────────────────

export class DirectorySchemaResource implements ResourcePort<
  typeof directorySchemaSpecSchema,
  typeof directorySchemaStateSchema
> {
  readonly kind = "DirectorySchema";
  readonly specSchema = directorySchemaSpecSchema;
  readonly stateSchema = directorySchemaStateSchema;
  readonly identitySchema = directorySchemaIdentitySchema;
  readonly desiredStateSchema = directorySchemaDesiredStateSchema;

  constructor(private readonly client: DirectoryClient | undefined) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "schemaId" in state) {
      if (typeof state.schemaId === "string" && state.schemaId.length > 0) {
        return state.schemaId;
      }
    }
    throw new ProviderApiError(PROVIDER_NAME, "getStateId", [
      {
        path: ["schemaId"],
        message: "State object does not contain a valid 'schemaId' field",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = directorySchemaSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "read", parsed.error.issues);
    }

    if (this.client === undefined) {
      throw new ProviderApiError(PROVIDER_NAME, "read", [
        { path: [], message: "Google Workspace provider not connected" },
      ]);
    }

    try {
      // Try to find the schema by name — list all schemas and match
      const listRaw = await this.client.listSchemas();
      const listResult = schemaListResponseSchema.safeParse(listRaw);
      if (!listResult.success) {
        throw new ProviderApiError(
          PROVIDER_NAME,
          "read",
          listResult.error.issues,
        );
      }

      const schemas = listResult.data.schemas ?? [];
      for (const rawSchema of schemas) {
        const schemaResult = schemaResponseSchema.safeParse(rawSchema);
        if (!schemaResult.success) continue;
        if (schemaResult.data.schemaName === parsed.data.schemaName) {
          return validateSchemaResponse(schemaResult.data, "read");
        }
      }

      return undefined;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "read");
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = directorySchemaSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "create", parsed.error.issues);
    }

    if (this.client === undefined) {
      throw new ProviderApiError(PROVIDER_NAME, "create", [
        { path: [], message: "Google Workspace provider not connected" },
      ]);
    }

    const body = buildSchemaBody(parsed.data);
    try {
      const response = await this.client.createSchema(body);
      return validateSchemaResponse(response, "create");
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "create");
    }
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = directorySchemaSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "update", parsed.error.issues);
    }

    if (this.client === undefined) {
      throw new ProviderApiError(PROVIDER_NAME, "update", [
        { path: [], message: "Google Workspace provider not connected" },
      ]);
    }

    // The Google API uses schemaName (not schemaId) as the URL key for PUT
    const body = buildSchemaBody(parsed.data);
    try {
      const response = await this.client.updateSchema(
        parsed.data.schemaName,
        body,
      );
      return validateSchemaResponse(response, "update");
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "update");
    }
  }
}
