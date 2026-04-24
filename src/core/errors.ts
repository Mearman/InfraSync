/**
 * Structured error types for the InfraSync engine.
 */

/** Issue representation that works across Zod versions. */
export interface ValidationIssue {
  readonly path: readonly string[];
  readonly message: string;
}

/**
 * Thrown by an adapter when a raw provider API response fails validation
 * against the adapter-internal apiResponseSchema.
 *
 * The engine catches these and adds them to allIssues for batch reporting.
 */
export class ProviderApiError extends Error {
  constructor(
    public readonly provider: string,
    public readonly operation: string,
    public readonly issues: ValidationIssue[],
  ) {
    super(
      `Provider "${provider}" ${operation} failed: ${String(issues.length)} validation issue(s)`,
    );
    this.name = "ProviderApiError";
  }
}

/**
 * Thrown by the DAG builder when a cycle is detected in the dependency graph.
 * The cyclePath shows the full cycle for debugging.
 */
export class DagCycleError extends Error {
  constructor(public readonly cyclePath: readonly string[]) {
    super(`Dependency cycle detected: ${cyclePath.join(" → ")}`);
    this.name = "DagCycleError";
  }
}
