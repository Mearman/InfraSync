/**
 * Convergence guards — resource-level preconditions for field convergence.
 *
 * A convergence guard declares that certain updates on a resource require
 * another resource (matched by a predicate) to be in a specific state.
 * The engine computes a transition sequence to satisfy the guard, applies
 * the guarded update, then restores the prerequisite resource.
 *
 * This is deterministic (the full plan is computed before any mutation)
 * and idempotent (already-converged resources are `no-op` on re-run).
 *
 * All matching logic is expressed as typed predicate functions defined by
 * the provider — no string field names. The provider author uses their own
 * Zod schemas and type guards for full compile-time safety.
 *
 * @example
 * // In the Entra provider, UserResource declares:
 * convergenceGuards: [{
 *   matchKind: DomainFederationConfigurationResource.kind,
 *   shouldGuard: (diff) =>
 *     diff.some(d => d.path === "onPremisesImmutableId"),
 *   matchResource: (userSpec, fedSpec) => {
 *     if (!isUserSpec(userSpec) || !isFederationSpec(fedSpec)) return false;
 *     const domain = userSpec.userPrincipalName.split("@")[1];
 *     return fedSpec.domain === domain;
 *   },
 *   requiredState: "absent",
 * }]
 */

import type { FieldDiff } from "./resource.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The state a prerequisite resource must be in before the guarded update.
 *
 * - `"absent"` — the resource must not exist (deleted and recreated)
 * - `"present"` — the resource must exist (created if missing)
 */
export type GuardRequiredState = "absent" | "present";

/**
 * A convergence guard declaration on a resource handler.
 *
 * Unlike stringly-typed configs, all matching logic is expressed as
 * predicate functions. The provider author has full type safety through
 * their own Zod schemas and type guards — the engine calls the
 * predicates with `unknown` values, and the predicates narrow internally.
 */
export interface ConvergenceGuard {
  /**
   * The resource kind to match. Use `ResourceClass.kind` for compile-time
   * safety — each resource class declares `kind` as a string literal.
   *
   * @example
   * matchKind: DomainFederationConfigurationResource.kind
   */
  readonly matchKind: string;

  /**
   * Predicate: given the divergent field diffs, should this guard activate?
   *
   * Replaces a string-based `guardFields` list with a type-safe predicate.
   * The provider author inspects `diff[].path` against known field names
   * from their schema — any typos are caught by the surrounding type guard
   * logic or unit tests, not silently ignored at the engine level.
   *
   * @param diff - Field-level differences between desired and actual state.
   *   Only populated when the action is "update".
   * @returns `true` if this guard must be satisfied before the update.
   */
  readonly shouldGuard: (diff: readonly FieldDiff[]) => boolean;

  /**
   * Predicate: given this resource's resolved spec and a candidate target
   * resource's spec, do they match?
   *
   * Replaces string-based `matchScope` + `extractScope` with a single
   * typed predicate. The provider author narrows both specs using their
   * own type guards — full compile-time safety, no string field names.
   *
   * @param thisSpec - This resource's resolved spec (unknown at the
   *   engine boundary — narrow with your own type guard).
   * @param targetSpec - The candidate target resource's spec (unknown at
   *   the engine boundary — narrow with your own type guard).
   * @returns `true` if the target resource is relevant to this guard.
   */
  readonly matchResource: (thisSpec: unknown, targetSpec: unknown) => boolean;

  /**
   * The state matched resources must be in before the guarded update.
   *
   * - `"absent"` — the resource is deleted, the guarded update runs,
   *   then the resource is recreated from its IR spec.
   * - `"present"` — the resource is created if missing, the guarded
   *   update runs, then the resource stays.
   */
  readonly requiredState: GuardRequiredState;
}

// ─── Guard matching ──────────────────────────────────────────────────────────

/**
 * A matched guard: a prerequisite resource that must transition before
 * the guarded update can proceed.
 */
export interface MatchedGuard {
  /** The IR resource name of the prerequisite resource. */
  readonly resourceName: string;
  /** The guard declaration that triggered the match. */
  readonly guard: ConvergenceGuard;
  /** The current state of the prerequisite resource (undefined = absent). */
  readonly currentState: unknown;
  /** What state the prerequisite must be in. */
  readonly requiredState: GuardRequiredState;
}

/**
 * Evaluate convergence guards against a resource update.
 *
 * Checks each guard's `shouldGuard` predicate against the divergent fields,
 * then matches against IR resources using `matchResource`. Returns the list
 * of guards that need to be satisfied before the update can proceed.
 *
 * @param guards - The resource handler's convergence guard declarations.
 * @param diff - Field-level differences between desired and actual state.
 * @param resolvedSpec - This resource's resolved spec (passed to
 *   `matchResource` as the first argument).
 * @param irResources - All resources in the IR (candidates for matching).
 * @param stateMap - Current resource states (used to determine if a
 *   matched resource is present or absent).
 * @returns Matched guards that need transitions. Empty if no guards
 *   trigger or all are already satisfied.
 */
export function matchGuards(
  guards: readonly ConvergenceGuard[],
  diff: readonly FieldDiff[],
  resolvedSpec: unknown,
  irResources: readonly {
    readonly name: string;
    readonly kind: string;
    readonly spec: unknown;
  }[],
  stateMap: ReadonlyMap<string, unknown>,
): readonly MatchedGuard[] {
  if (guards.length === 0) return [];

  // Filter to guards whose shouldGuard predicate activates
  const triggered = guards.filter((guard) => guard.shouldGuard(diff));
  if (triggered.length === 0) return [];

  const matched: MatchedGuard[] = [];

  for (const guard of triggered) {
    for (const irResource of irResources) {
      if (irResource.kind !== guard.matchKind) continue;

      // Ask the guard's predicate if this target matches
      if (!guard.matchResource(resolvedSpec, irResource.spec)) continue;

      const currentState = stateMap.get(irResource.name);
      matched.push({
        resourceName: irResource.name,
        guard,
        currentState,
        requiredState: guard.requiredState,
      });
    }
  }

  return matched;
}

// ─── Transition plan ─────────────────────────────────────────────────────────

/**
 * A single step in a transition plan to satisfy convergence guards.
 */
export type TransitionStep =
  | {
      readonly type: "delete";
      readonly resourceName: string;
      readonly provider: string;
      readonly kind: string;
    }
  | {
      readonly type: "recreate";
      readonly resourceName: string;
      readonly provider: string;
      readonly kind: string;
      readonly spec: unknown;
    };

/**
 * Compute the transition steps needed to satisfy a set of matched guards.
 *
 * Returns `undefined` if no transitions are needed (all guards are already
 * satisfied). Otherwise returns an ordered list of delete and recreate
 * steps. The caller applies deletions, runs the guarded update, then
 * applies recreations.
 *
 * Duplicate resources are de-duplicated — if two guards both require the
 * same resource to be absent, only one delete/recreate pair is emitted.
 */
export function planTransitions(
  matched: readonly MatchedGuard[],
  irResources: readonly {
    readonly name: string;
    readonly provider: string;
    readonly kind: string;
    readonly spec: unknown;
  }[],
): TransitionStep[] | undefined {
  if (matched.length === 0) return undefined;

  const seenResources = new Set<string>();
  const steps: TransitionStep[] = [];
  let needsTransition = false;

  for (const match of matched) {
    // De-duplicate — each prerequisite resource appears at most once
    if (seenResources.has(match.resourceName)) continue;
    seenResources.add(match.resourceName);

    const irResource = irResources.find((r) => r.name === match.resourceName);
    if (irResource === undefined) continue;

    const isPresent = match.currentState !== undefined;

    if (match.requiredState === "absent" && isPresent) {
      needsTransition = true;
      steps.push({
        type: "delete",
        resourceName: match.resourceName,
        provider: irResource.provider,
        kind: irResource.kind,
      });
      steps.push({
        type: "recreate",
        resourceName: match.resourceName,
        provider: irResource.provider,
        kind: irResource.kind,
        spec: irResource.spec,
      });
    } else if (match.requiredState === "present" && !isPresent) {
      needsTransition = true;
      steps.push({
        type: "recreate",
        resourceName: match.resourceName,
        provider: irResource.provider,
        kind: irResource.kind,
        spec: irResource.spec,
      });
    }
    // Already in the required state — no transition needed
  }

  return needsTransition ? steps : undefined;
}
