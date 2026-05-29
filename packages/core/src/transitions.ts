/**
 * Typed transition and precondition declarations for resource adapters.
 *
 * Transitions replace the convergence guard mechanism with a declarative,
 * spec-centric model. Instead of declaring operations (stop, start, delete),
 * adapters declare intermediate specs — each step is a value of the
 * resource's own spec type, validated through the Zod schema.
 *
 * Two forms:
 * - Data-only (steps): partial spec overlays merged over the desired spec.
 *   Pure by construction — no function, no closure, no external access.
 * - Function (computeSteps): for dynamic transition paths. Documented as
 *   must-be-pure. The planner calls it once during planning and freezes
 *   the result.
 *
 * Cross-resource preconditions reference schema objects directly (not kind
 * strings). The planner resolves schema → kind → handler at plan time.
 */
import type * as z from "zod";

// ─── Single-resource transitions ─────────────────────────────────────────────

/**
 * A transition declares intermediate specs to apply when guarded fields
 * diverge between desired and current state.
 *
 * The planner evaluates transitions during the Plan phase. Each step
 * produces an action node in the DAG with sequential dependency edges.
 * The last step is always the user's desired spec — the planner appends
 * it if the declaration doesn't include it.
 *
 * Example (data-only — stop → reconfigure → start):
 * ```typescript
 * transitions: [{
 *   guardFields: ["image"],
 *   steps: [
 *     { state: "stopped" },   // step 1: stop (partial overlay)
 *     {},                      // step 2: desired spec as-is (empty overlay)
 *     // step 3 is implicit: desired spec with state: "running"
 *   ],
 * }]
 * ```
 *
 * Example (function — version-dependent migration):
 * ```typescript
 * transitions: [{
 *   guardFields: ["schemaVersion"],
 *   computeSteps: (desired, current) => {
 *     if (current.schemaVersion === 1) {
 *       return [
 *         { ...desired, schemaVersion: 2, migrationMode: "v1-to-v2" },
 *         desired,
 *       ];
 *     }
 *     return [desired];
 *   },
 * }]
 * ```
 */
export type TransitionDeclaration<
  TSpec extends z.ZodType = z.ZodType,
  TState extends z.ZodType = z.ZodType,
> = {
  /**
   * Fields on this resource that, when divergent between desired and
   * current state, trigger this transition.
   *
   * Typed as `keyof z.infer<TSpec> & string` on the concrete declaration,
   * catching typos at compile time.
   */
  readonly guardFields: readonly string[];
} & (
  | {
      /**
       * Data-only form: partial spec overlays merged over the desired spec.
       * Each overlay is validated through specSchema by the planner.
       *
       * Pure by construction — no function, no closure, no external access.
       * The recommended form for most transitions.
       */
      readonly steps: readonly Record<string, unknown>[];
    }
  | {
      /**
       * Function form: for dynamic transition paths where the steps depend
       * on the current state.
       *
       * Documented as must-be-pure. Receives only (desired, current) — no
       * access to environment variables, network, or mutable state. The
       * planner calls it once during planning and freezes the result into
       * action nodes.
       *
       * The last entry should be the user's desired spec. If it isn't,
       * the planner appends it.
       */
      readonly computeSteps: (
        desired: z.infer<TSpec>,
        current: z.infer<TState>,
      ) => readonly z.infer<TSpec>[];
    }
);

// ─── Cross-resource preconditions ────────────────────────────────────────────

/**
 * A precondition declares that another resource must be in a specific state
 * before this resource can be updated.
 *
 * References schema objects directly (not kind strings) for compile-time
 * identity checking. The planner resolves schema → kind → handler at plan
 * time using the adapter registry.
 *
 * Example (Entra ID user update requires federation config absent):
 * ```typescript
 * preconditions: [{
 *   target: domainFederationSpecSchema,
 *   matchOn: "domain",
 *   guardFields: ["onPremisesImmutableId"],
 *   required: "absent",
 * }]
 * ```
 *
 * The planner produces action nodes:
 * 1. delete target resource (before guarded update)
 * 2. update this resource (the guarded operation)
 * 3. create target resource (restore after guarded update)
 */
export interface PreconditionDeclaration<TSpec extends z.ZodType = z.ZodType> {
  /**
   * Schema object reference for the target resource kind.
   * The planner resolves this to a kind string via the adapter registry
   * using schema identity (===) comparison.
   *
   * This eliminates kind string typos — if the schema object doesn't
   * match any registered handler, the planner fails with a clear error.
   */
  readonly target: z.ZodType;

  /**
   * Field or function to determine whether a target resource instance
   * is relevant to this precondition.
   *
   * - String form: a field name that must be equal on both the source
   *   and target specs. Both specs must have a field with this name.
   * - Function form: a pure predicate receiving both specs, returning
   *   true if the target matches. Use when the matching requires
   *   derived values (e.g. extracting a domain from an email address).
   *   Documented as must-be-pure.
   *
   * When omitted, all resources of the target kind are matched.
   */
  readonly matchOn?:
    | string
    | ((source: z.infer<TSpec>, target: unknown) => boolean);

  /**
   * Fields on this resource that, when divergent between desired and
   * current state, trigger this precondition.
   *
   * When empty or omitted, the precondition applies to any update.
   */
  readonly guardFields: readonly string[];

  /**
   * The required state of the target resource before the guarded update.
   *
   * - "absent" — target is deleted, guarded update runs, target recreated.
   * - "present" — target is created if missing, guarded update runs,
   *   target stays (no restore needed if already present).
   */
  readonly required: "absent" | "present";
}
