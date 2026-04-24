// ─── Plan types ──────────────────────────────────────────────────────────────

/** The action the engine determined for a resource. */
export type PlanAction = "create" | "update" | "no-op" | "read";

/** A resource's planned action within a sync run. */
export interface PlanEntry {
  readonly resource: string;
  readonly action: PlanAction;
}

// ─── Plan computation ────────────────────────────────────────────────────────

/**
 * Compute the plan action for a resource given its mode and current state.
 *
 * - Read-mode resources always get action "read" — no convergence check.
 * - Manage-mode resources with no current state get action "create".
 * - Manage-mode resources with state get action "update" (convergence is
 *   checked separately by the engine using desiredStateSchema + deepEqual).
 *
 * The "no-op" action is set by the engine after convergence checking —
 * this function returns "update" when state exists, and the engine refines
 * it to "no-op" if the desired and actual states match.
 */
export function computePlan(
  mode: "manage" | "read",
  state: unknown,
): PlanAction {
  if (mode === "read") return "read";
  if (state === undefined) return "create";
  return "update";
}
