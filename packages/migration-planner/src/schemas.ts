/**
 * Canonical Zod schemas for the migration planner.
 *
 * All types are derived via `z.infer`. No standalone interfaces.
 */
import * as z from "zod";

// ─── Primitives ──────────────────────────────────────────────────────────────

export const migrationDirectionSchema = z.enum([
  "tf-to-infrasync",
  "infrasync-to-tf",
]);

export type MigrationDirection = z.infer<typeof migrationDirectionSchema>;

export const safetyClassificationSchema = z.enum([
  "safe",
  "risky",
  "destructive",
]);

export type SafetyClassification = z.infer<typeof safetyClassificationSchema>;

export const resourceActionSchema = z.enum([
  "create",
  "update",
  "delete",
  "unchanged",
  "unresolvable",
]);

export type ResourceAction = z.infer<typeof resourceActionSchema>;

export const stepActionSchema = z.enum([
  "create",
  "update",
  "delete",
  "replace-create",
  "replace-destroy",
  "replace",
  "verify",
  "manual-intervention",
]);

export type StepAction = z.infer<typeof stepActionSchema>;

export const stepTargetSchema = z.enum(["terraform", "infrasync"]);

export type StepTarget = z.infer<typeof stepTargetSchema>;

// ─── Resource Key ────────────────────────────────────────────────────────────

export const resourceKeySchema = z.object({
  /** TF address (e.g. "cloudflare_record.www") or InfraSync name */
  name: z.string().trim().min(1),
  /** TF type (e.g. "cloudflare_record") or InfraSync kind (e.g. "CloudflareRecord") */
  type: z.string().trim().min(1),
  /** Provider/adapter name */
  provider: z.string().trim().min(1),
});

export type ResourceKey = z.infer<typeof resourceKeySchema>;

// ─── Attribute Diff ──────────────────────────────────────────────────────────

export const attributeDiffSchema = z.object({
  /** Dot-notation path, e.g. "spec.ttl" */
  path: z.string().trim().min(1),
  /** Value in the source document */
  before: z.unknown(),
  /** Value in the target document */
  after: z.unknown(),
  /** Safety classification */
  safety: safetyClassificationSchema,
  /** Which rule produced this classification */
  rule: z.string().trim().min(1),
  /** Mitigation strategy from the matching rule, if any */
  mitigation: z
    .enum([
      "create-before-destroy",
      "destroy-before-create",
      "in-place-replace",
      "none",
    ])
    .optional(),
});

export type AttributeDiff = z.infer<typeof attributeDiffSchema>;

// ─── Destruction Mitigation ──────────────────────────────────────────────────

export const mitigationStrategySchema = z.object({
  /** Whether this destructive change can be automated with a safe strategy */
  automated: z.boolean(),
  /** The replacement strategy */
  strategy: z.enum([
    "create-before-destroy",
    "destroy-before-create",
    "in-place-replace",
    "none",
  ]),
  /** Whether the strategy preserves data during replacement */
  preservesData: z.boolean(),
  /** Whether downtime is required */
  requiresDowntime: z.boolean(),
  /** Human-readable explanation of the mitigation */
  description: z.string().trim().min(1),
});

export type MitigationStrategy = z.infer<typeof mitigationStrategySchema>;

// ─── Resource Change ─────────────────────────────────────────────────────────

export const resourceChangeSchema = z.object({
  /** Key in the TerraformIR (absent if TF doesn't have this resource) */
  tfKey: resourceKeySchema.optional(),
  /** Key in the InfraIR (absent if InfraSync doesn't have this resource) */
  infraKey: resourceKeySchema.optional(),
  /** Overall action */
  action: resourceActionSchema,
  /** Field-level diffs */
  attributeDiffs: z.array(attributeDiffSchema).readonly(),
  /** Worst safety across all diffs */
  safety: safetyClassificationSchema,
  /** How destructive changes can be mitigated */
  mitigation: mitigationStrategySchema.optional(),
});

export type ResourceChange = z.infer<typeof resourceChangeSchema>;

// ─── Migration Step ──────────────────────────────────────────────────────────

export const migrationStepSchema = z.object({
  /** Unique step identifier */
  id: z.string().trim().min(1),
  /** What to do */
  action: stepActionSchema,
  /** Which system to target */
  target: stepTargetSchema,
  /** Resource type (e.g. "cloudflare_record") */
  resourceType: z.string().trim().min(1),
  /** Resource name */
  resourceName: z.string().trim().min(1),
  /** Human-readable explanation */
  description: z.string().trim().min(1),
  /** Safety classification */
  safety: safetyClassificationSchema,
  /** Step IDs this depends on — enforces ordering */
  dependsOn: z.array(z.string().trim().min(1)).readonly(),
  /** The actual change data */
  payload: z.unknown(),
  /** Destructive/unresolvable steps need explicit confirmation */
  requiresConfirmation: z.boolean(),
  /** Terraform lifecycle metadata affecting step behaviour */
  lifecycle: z
    .object({
      createBeforeDestroy: z.boolean().optional(),
      preventDestroy: z.boolean().optional(),
      ignoreChanges: z.array(z.string().trim()).optional(),
    })
    .optional(),
});

export type MigrationStep = z.infer<typeof migrationStepSchema>;

// ─── Migration Summary ───────────────────────────────────────────────────────

export const migrationSummarySchema = z.object({
  total: z.int().min(0),
  unchanged: z.int().min(0),
  safe: z.int().min(0),
  risky: z.int().min(0),
  destructive: z.int().min(0),
  creates: z.int().min(0),
  deletes: z.int().min(0),
  updates: z.int().min(0),
});

export type MigrationSummary = z.infer<typeof migrationSummarySchema>;

// ─── Migration Plan ──────────────────────────────────────────────────────────

export const migrationPlanSchema = z.object({
  direction: migrationDirectionSchema,
  changes: z.array(resourceChangeSchema).readonly(),
  steps: z.array(migrationStepSchema).readonly(),
  summary: migrationSummarySchema,
  warnings: z.array(z.string().trim()).readonly(),
});

export type MigrationPlan = z.infer<typeof migrationPlanSchema>;

// ─── Plugin System ───────────────────────────────────────────────────────────

export const resourceMappingSchema = z.object({
  /** TF resource type to match */
  tfType: z.string().trim().min(1),
  /** InfraSync resource kind to match */
  infraKind: z.string().trim().min(1),
});

export type ResourceMapping = z.infer<typeof resourceMappingSchema>;

export const safetyRuleSchema = z.object({
  /** Attribute path pattern (exact string or regex source) */
  path: z.string().trim().min(1),
  /** Whether this is a regex pattern */
  pathIsRegex: z.boolean(),
  /** Which actions this rule applies to */
  actions: z.array(resourceActionSchema).readonly(),
  /** Which direction this rule applies to */
  direction: z.union([migrationDirectionSchema, z.literal("both")]),
  /** Explicit severity when this rule matches */
  severity: safetyClassificationSchema,
  /** Whether this change can be mitigated with create-before-destroy */
  mitigation: z
    .enum([
      "create-before-destroy",
      "destroy-before-create",
      "in-place-replace",
      "none",
    ])
    .optional(),
  /** Human-readable description */
  description: z.string().trim().min(1),
});

export type SafetyRule = z.infer<typeof safetyRuleSchema>;

export const attributeMapperSchema = z.object({
  /** Attribute path in the Terraform representation */
  tfPath: z.string().trim().min(1),
  /** Attribute path in the InfraSync representation */
  infraPath: z.string().trim().min(1),
});

export type AttributeMapper = z.infer<typeof attributeMapperSchema>;

export const migrationPluginSchema = z.object({
  /** Plugin identifier */
  name: z.string().trim().min(1),
  /** Which adapter this handles (e.g. "cloudflare") */
  adapterName: z.string().trim().min(1),
  /** How to match TF types to InfraSync kinds */
  resourceMappings: z.array(resourceMappingSchema).readonly(),
  /** Safety rules for attribute changes */
  safetyRules: z.array(safetyRuleSchema).readonly(),
  /** Attribute path mappings between TF and InfraSync */
  attributeMappers: z.array(attributeMapperSchema).readonly(),
});

export type MigrationPlugin = z.infer<typeof migrationPluginSchema>;
