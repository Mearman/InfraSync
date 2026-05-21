/**
 * Action DAG — the serialisable plan that the executor consumes.
 *
 * Every phase boundary in InfraSync produces plain JSON. The Action DAG
 * is the output of the Plan phase and the input to the Execute phase.
 *
 * Action nodes carry specs (declarations of desired state), not operations.
 * The executor determines the operation from current state comparison.
 *
 * Whether an action came from a normal resource, a transition step, or a
 * precondition is invisible to the executor — all are action nodes with
 * dependency edges. One code path, no branching.
 */
import * as z from "zod";

// ─── Action types ────────────────────────────────────────────────────────────

/**
 * The set of operations the executor can perform.
 *
 * These are derived at plan time from current state comparison.
 * They are not declared by adapters — adapters declare specs, the
 * planner determines actions.
 */
export const planActionSchema = z.enum([
  "create",
  "update",
  "delete",
  "no-op",
  "read",
]);

export type PlanAction = z.infer<typeof planActionSchema>;

// ─── Field diff ──────────────────────────────────────────────────────────────

export const fieldDiffSchema = z.object({
  path: z.string(),
  desired: z.unknown(),
  actual: z.unknown(),
});

export type FieldDiff = z.infer<typeof fieldDiffSchema>;

// ─── Action node ─────────────────────────────────────────────────────────────

/**
 * A single action node in the DAG.
 *
 * Carries a spec — a declaration of desired state. The executor applies
 * this spec through the adapter port and validates the result through
 * the state schema.
 *
 * Dependency edges (deps) reference other action node IDs. The executor
 * processes the DAG level by level, parallel within each level.
 */
export const actionNodeSchema = z.object({
  /** Unique identifier within the DAG */
  id: z.string(),
  /** The operation to perform */
  action: planActionSchema,
  /** IR resource name this action targets */
  resource: z.string(),
  /** Provider instance key */
  provider: z.string(),
  /** Resource kind within the provider */
  kind: z.string(),
  /**
   * The spec to apply. Validated through specSchema at plan time.
   * Plain JSON — no schema references, no RefTokenIR values.
   */
  spec: z.unknown(),
  /**
   * Provider-assigned ID for update/delete actions.
   * undefined for create/read/no-op.
   */
  stateId: z.string().optional(),
  /**
   * Field-level diff for update actions.
   * undefined for create/read/delete/no-op.
   */
  diff: z.array(fieldDiffSchema).optional(),
  /** IDs of actions that must complete before this one */
  deps: z.array(z.string()),
});

export type ActionNode = z.infer<typeof actionNodeSchema>;

// ─── Action DAG ──────────────────────────────────────────────────────────────

/**
 * The complete action DAG — the output of the Plan phase.
 *
 * Serialisable to JSON. Can be saved, transmitted, and executed
 * in a separate process. The executor consumes only this structure
 * plus the adapter registry.
 *
 * Metadata fields enable reproducibility verification:
 * - planTimestamp: when the plan was produced
 * - infraIRHash: SHA-256 of the serialised InfraIR
 * - stateMapHash: SHA-256 of the serialised StateMap
 */
export const actionDagSchema = z.object({
  /** The action nodes, in no particular order (executor topologically sorts) */
  actions: z.array(actionNodeSchema),
  /** ISO-8601 timestamp when this plan was produced */
  planTimestamp: z.string().datetime({ local: true }),
  /** SHA-256 hex digest of the serialised InfraIR used to produce this plan */
  infraIRHash: z.string(),
  /** SHA-256 hex digest of the serialised StateMap used to produce this plan */
  stateMapHash: z.string(),
});

export type ActionDag = z.infer<typeof actionDagSchema>;

// ─── JSON Schema export ─────────────────────────────────────────────────────

export const actionDagJsonSchema = z.toJSONSchema(actionDagSchema);
