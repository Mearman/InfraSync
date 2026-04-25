/**
 * Canonical Zod schemas for Terraform show JSON wire formats.
 *
 * These schemas model the exact shape of:
 *   - `terraform show -json <state>` → TF-Show State JSON
 *   - `terraform show -json <plan>`  → TF-Show Plan JSON
 *
 * Schemas use `z.looseObject` where forward-compatibility is required
 * (unknown fields must be accepted on supported major versions).
 * Strict schemas are used for fields where we need exact validation.
 *
 * Types are inferred from these schemas. Parse at the adapter boundary only.
 */
import * as z from "zod";

// ─── Shared: values representation resource instance ─────────────────────────

export const tfShowResourceInstanceSchema = z.looseObject({
  address: z.string().trim(),
  mode: z.enum(["managed", "data"]),
  type: z.string().trim(),
  name: z.string().trim(),
  index: z.union([z.number(), z.string().trim()]).optional(),
  provider_name: z.string().trim().optional(),
  schema_version: z.number().optional(),
  values: z.record(z.string(), z.unknown()).optional(),
  sensitive_values: z.unknown().optional(),
  depends_on: z.array(z.string().trim()).optional(),
});

// ─── Shared: module with resources and child modules ─────────────────────────

export const tfShowModuleSchema: z.ZodType<TFShowModule> = z.lazy(() =>
  z.looseObject({
    address: z.string().trim().optional(),
    resources: z.array(tfShowResourceInstanceSchema).optional(),
    child_modules: z.array(tfShowModuleSchema).optional(),
  }),
);

export interface TFShowModule {
  readonly address?: string | undefined;
  readonly resources?:
    | readonly z.infer<typeof tfShowResourceInstanceSchema>[]
    | undefined;
  readonly child_modules?: readonly TFShowModule[] | undefined;
}

// ─── Shared: values representation ───────────────────────────────────────────

export const tfShowValuesSchema = z.looseObject({
  outputs: z
    .record(
      z.string(),
      z.looseObject({
        value: z.unknown().optional(),
        type: z.unknown().optional(),
        sensitive: z.boolean().optional(),
      }),
    )
    .optional(),
  root_module: tfShowModuleSchema.optional(),
});

// ─── Shared: output in state (with value, type, sensitive) ────────────────────

export const tfShowStateOutputSchema = z.looseObject({
  value: z.unknown().optional(),
  type: z.unknown().optional(),
  sensitive: z.boolean().optional(),
});

// ─── State envelope ──────────────────────────────────────────────────────────

export const tfShowStateEnvelopeSchema = z.looseObject({
  format_version: z.string().trim(),
  terraform_version: z.string().trim().optional(),
  values: tfShowValuesSchema.optional(),
});

// ─── Plan: change representation ─────────────────────────────────────────────

export const tfShowChangeActionSchema = z.enum([
  "no-op",
  "create",
  "read",
  "update",
  "delete",
]);

export const tfShowChangeSchema = z.looseObject({
  actions: z.array(tfShowChangeActionSchema),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  after_unknown: z.unknown().optional(),
  before_sensitive: z.unknown().optional(),
  after_sensitive: z.unknown().optional(),
  replace_paths: z
    .array(z.array(z.union([z.string().trim(), z.number()])))
    .optional(),
  importing: z.looseObject({ id: z.string().trim() }).optional(),
});

// ─── Plan: resource change entry ─────────────────────────────────────────────

export const tfShowResourceChangeSchema = z.looseObject({
  address: z.string().trim(),
  previous_address: z.string().trim().optional(),
  module_address: z.string().trim().optional(),
  mode: z.enum(["managed", "data"]).optional(),
  type: z.string().trim().optional(),
  name: z.string().trim().optional(),
  index: z.union([z.number(), z.string().trim()]).optional(),
  deposed: z.string().trim().optional(),
  provider_name: z.string().trim().optional(),
  change: tfShowChangeSchema.optional(),
  action_reason: z.string().trim().optional(),
});

// ─── Plan: output change ─────────────────────────────────────────────────────

export const tfShowOutputChangeSchema = z.looseObject({
  change: tfShowChangeSchema.optional(),
});

// ─── Plan: relevant attribute ────────────────────────────────────────────────

export const tfShowRelevantAttributeSchema = z.looseObject({
  resource: z.string().trim(),
  attribute: z.string().trim(),
});

// ─── Plan: checks ────────────────────────────────────────────────────────────

export const tfShowCheckProblemSchema = z.looseObject({
  message: z.string().trim().optional(),
});

export const tfShowCheckInstanceSchema = z.looseObject({
  address: z.unknown().optional(),
  status: z.enum(["pass", "fail", "error", "unknown"]).optional(),
  problems: z.array(tfShowCheckProblemSchema).optional(),
});

export const tfShowCheckSchema = z.looseObject({
  address: z.unknown().optional(),
  status: z.enum(["pass", "fail", "error", "unknown"]).optional(),
  instances: z.array(tfShowCheckInstanceSchema).optional(),
});

// ─── Plan: variable ──────────────────────────────────────────────────────────

export const tfShowVariableSchema = z.looseObject({
  value: z.unknown().optional(),
});

// ─── Plan envelope ───────────────────────────────────────────────────────────

export const tfShowPlanEnvelopeSchema = z.looseObject({
  format_version: z.string().trim(),
  terraform_version: z.string().trim().optional(),
  applyable: z.boolean().optional(),
  complete: z.boolean().optional(),
  errored: z.boolean().optional(),
  planned_values: tfShowValuesSchema.optional(),
  proposed_unknown: tfShowValuesSchema.optional(),
  prior_state: z.unknown().optional(),
  configuration: z.unknown().optional(),
  variables: z.record(z.string(), tfShowVariableSchema).optional(),
  resource_changes: z.array(tfShowResourceChangeSchema).optional(),
  resource_drift: z.array(tfShowResourceChangeSchema).optional(),
  relevant_attributes: z.array(tfShowRelevantAttributeSchema).optional(),
  output_changes: z.record(z.string(), tfShowOutputChangeSchema).optional(),
  checks: z.array(tfShowCheckSchema).optional(),
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TFShowResourceInstance = z.infer<
  typeof tfShowResourceInstanceSchema
>;
export type TFShowValues = z.infer<typeof tfShowValuesSchema>;
export type TFShowStateEnvelope = z.infer<typeof tfShowStateEnvelopeSchema>;
export type TFShowChangeAction = z.infer<typeof tfShowChangeActionSchema>;
export type TFShowChange = z.infer<typeof tfShowChangeSchema>;
export type TFShowResourceChange = z.infer<typeof tfShowResourceChangeSchema>;
export type TFShowPlanEnvelope = z.infer<typeof tfShowPlanEnvelopeSchema>;
export type TFShowCheckSchema = z.infer<typeof tfShowCheckSchema>;

// ─── JSON Schema exports ─────────────────────────────────────────────────────

export const tfShowStateJsonSchema = z.toJSONSchema(tfShowStateEnvelopeSchema);
export const tfShowPlanJsonSchema = z.toJSONSchema(tfShowPlanEnvelopeSchema);
