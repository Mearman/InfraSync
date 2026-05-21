/**
 * Phase 3: Execute the action DAG.
 *
 * Generic DAG processor. No domain logic, no branching on resource types,
 * no guard handling. Just:
 * 1. Topological sort action nodes by dependency edges.
 * 2. Process level by level, parallel within each level.
 * 3. For each action: resolve handler, apply spec through adapter port,
 *    validate result through stateSchema, record outcome.
 *
 * Idempotent: re-reads state before applying. Already-converged actions
 * become no-ops.
 */
import {
  ResolvedScopes,
  type ProviderPort,
  type ResourcePort,
} from "./provider.js";
import type { ResourceIssue, FieldDiff } from "./resource.js";
import {
  collectZodIssues,
  deepEqual,
  isRecord,
  resolveRefs,
  resolveScopes,
} from "./resource.js";
import { ProviderApiError } from "./errors.js";
import type { ActionDag, ActionNode, PlanAction } from "./action-dag.js";

// ─── Semaphore ───────────────────────────────────────────────────────────────

/**
 * Simple counting semaphore for limiting concurrent operations.
 *
 * Uses only stdlib — no third-party dependencies. Callers `await acquire()`
 * to obtain a release function; the semaphore blocks when all slots are taken
 * and resumes when a slot is released.
 */
export class Semaphore {
  private readonly queue: (() => void)[] = [];
  private active = 0;

  constructor(private readonly max: number) {
    if (max < 1) {
      throw new RangeError(
        `Semaphore max must be at least 1, got ${String(max)}`,
      );
    }
  }

  /**
   * Acquire a slot. Returns a release function once a slot is available.
   * Blocks (via Promise) if all slots are currently held.
   */
  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.active--;
        const next = this.queue.shift();
        if (next !== undefined) {
          this.active++;
          next();
        }
      };
    }
    return new Promise<() => void>((resolve) => {
      let released = false;
      this.queue.push(() => {
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          const next = this.queue.shift();
          if (next !== undefined) {
            this.active++;
            next();
          }
        });
      });
    });
  }
}

// ─── Convergence verification ────────────────────────────────────────────────

/** Maximum total attempts for convergence verification (initial + retries). */
const CONVERGENCE_MAX_ATTEMPTS = 3;

/**
 * Verify convergence after a write operation.
 *
 * If the handler declares a `convergenceDelay`, waits that many milliseconds,
 * reads back the state, validates it through the state schema, and compares
 * against the expected result. Retries with exponential backoff on mismatch.
 *
 * Returns the verified state, or undefined if the handler has no convergence delay
 * (meaning the provider is strongly consistent and no verification is needed).
 */
async function verifyConvergence(
  handler: ResourcePort,
  resolvedSpec: unknown,
  expectedState: unknown,
  resourceName: string,
  issues: ResourceIssue[],
): Promise<{ verified: boolean; state: unknown }> {
  if (handler.convergenceDelay === undefined) {
    return { verified: true, state: expectedState };
  }

  for (let attempt = 1; attempt <= CONVERGENCE_MAX_ATTEMPTS; attempt++) {
    // Wait before reading back (exponential backoff on retries)
    const delay =
      handler.convergenceDelay * (attempt === 1 ? 1 : Math.pow(2, attempt - 1));
    await sleep(delay);

    const currentState = await handler.read(resolvedSpec);

    // Validate the read result through the state schema
    const parseResult = handler.stateSchema.safeParse(currentState);
    if (!parseResult.success) {
      if (attempt === CONVERGENCE_MAX_ATTEMPTS) {
        issues.push(...collectZodIssues(resourceName, parseResult.error));
        return { verified: false, state: expectedState };
      }
      continue;
    }

    // Compare the verified state against the expected result
    if (deepEqual(parseResult.data, expectedState)) {
      return { verified: true, state: parseResult.data };
    }

    // Mismatch — retry if attempts remain
    if (attempt === CONVERGENCE_MAX_ATTEMPTS) {
      issues.push({
        resource: resourceName,
        message:
          `Convergence verification failed after ${String(CONVERGENCE_MAX_ATTEMPTS)} attempts: ` +
          `read-back state does not match expected result`,
      });
      return { verified: false, state: expectedState };
    }
  }

  // Should not reach here, but satisfy the type checker
  return { verified: false, state: expectedState };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExecutePhaseInput {
  readonly actionDag: ActionDag;
  readonly instances: Map<string, ProviderPort>;
  readonly configs: Map<string, Record<string, unknown>>;
  /** Initial state from the read phase, used to seed the executor's state map. */
  readonly initialState?: Record<string, unknown>;
  readonly dryRun: boolean;
}

/** Per-resource outcome from execution. */
export interface ResourceOutcome {
  readonly name: string;
  readonly action: PlanAction;
  readonly status: "success" | "failed";
  readonly state: unknown;
  readonly diff: readonly FieldDiff[];
}

/** The result of a sync execution. */
export interface ExecutePhaseOutput {
  readonly result: {
    readonly resources: readonly ResourceOutcome[];
    readonly issues: readonly ResourceIssue[];
  };
}

// ─── Outcome factories ───────────────────────────────────────────────────────

function fail(
  name: string,
  action: PlanAction,
  diff: readonly FieldDiff[] = [],
): ResourceOutcome {
  return { name, action, status: "failed", state: undefined, diff };
}

function succeed(
  name: string,
  action: PlanAction,
  state: unknown,
  diff: readonly FieldDiff[] = [],
): ResourceOutcome {
  return { name, action, status: "success", state, diff };
}

// ─── Execute phase ───────────────────────────────────────────────────────────

/**
 * Phase 3: Execute the action DAG.
 *
 * Generic DAG processor — no domain logic, no branching on resource types,
 * no guard handling. Processes action nodes in topological order, parallel
 * within each dependency level.
 *
 * Idempotent: re-reads state before applying. Already-converged actions
 * become no-ops.
 */
export async function executePhase(
  input: ExecutePhaseInput,
): Promise<ExecutePhaseOutput> {
  const { actionDag, instances, configs, dryRun } = input;
  const issues: ResourceIssue[] = [];
  const outcomes: ResourceOutcome[] = [];
  const stateMap = new Map<string, unknown>();

  // Seed the state map with read-phase state for ref resolution
  if (input.initialState !== undefined) {
    for (const [key, value] of Object.entries(input.initialState)) {
      stateMap.set(key, value);
    }
  }

  // Build dependency graph for the action DAG
  const actionMap = new Map<string, ActionNode>();
  for (const action of actionDag.actions) {
    actionMap.set(action.id, action);
  }

  // Topological sort the action nodes
  const levels = topologicalSortActions(actionDag.actions);

  for (const level of levels) {
    await executeLevel(
      level,
      instances,
      configs,
      stateMap,
      issues,
      outcomes,
      dryRun,
    );
  }

  return {
    result: { resources: outcomes, issues },
  };
}

// ─── Level execution ─────────────────────────────────────────────────────────

/**
 * Execute all actions within a single DAG level.
 *
 * Partitions actions by provider. Providers with `maxConcurrency` are
 * throttled via a semaphore; providers without limits run fully parallel.
 * All provider groups run concurrently with each other.
 */
async function executeLevel(
  level: readonly ActionNode[],
  instances: Map<string, ProviderPort>,
  configs: Map<string, Record<string, unknown>>,
  stateMap: Map<string, unknown>,
  issues: ResourceIssue[],
  outcomes: ResourceOutcome[],
  dryRun: boolean,
): Promise<void> {
  // Partition actions by provider
  const byProvider = new Map<string, ActionNode[]>();
  for (const action of level) {
    const existing = byProvider.get(action.provider);
    if (existing !== undefined) {
      existing.push(action);
    } else {
      byProvider.set(action.provider, [action]);
    }
  }

  // Execute each provider group concurrently
  const groupPromises: Promise<void>[] = [];

  for (const [providerName, actions] of byProvider) {
    const provider = instances.get(providerName);
    if (provider === undefined) {
      // Provider not connected — executeAction will report the issue
      groupPromises.push(
        ...actions.map((action) =>
          executeAction(
            action,
            instances,
            configs,
            stateMap,
            issues,
            outcomes,
            dryRun,
          ),
        ),
      );
      continue;
    }

    const maxConcurrency = provider.maxConcurrency;

    if (maxConcurrency !== undefined) {
      // Rate-limited execution via semaphore
      groupPromises.push(
        executeWithSemaphore(
          actions,
          maxConcurrency,
          instances,
          configs,
          stateMap,
          issues,
          outcomes,
          dryRun,
        ),
      );
    } else {
      // No limit — fully parallel within this provider group
      groupPromises.push(
        ...actions.map((action) =>
          executeAction(
            action,
            instances,
            configs,
            stateMap,
            issues,
            outcomes,
            dryRun,
          ),
        ),
      );
    }
  }

  await Promise.all(groupPromises);
}

/**
 * Execute a batch of actions with a semaphore limiting concurrency.
 *
 * Each action acquires a slot before executing and releases it after
 * completion (success or failure). The semaphore guarantees at most
 * `maxConcurrency` actions are in-flight simultaneously.
 */
async function executeWithSemaphore(
  actions: readonly ActionNode[],
  maxConcurrency: number,
  instances: Map<string, ProviderPort>,
  configs: Map<string, Record<string, unknown>>,
  stateMap: Map<string, unknown>,
  issues: ResourceIssue[],
  outcomes: ResourceOutcome[],
  dryRun: boolean,
): Promise<void> {
  const semaphore = new Semaphore(maxConcurrency);

  await Promise.all(
    actions.map(async (action) => {
      const release = await semaphore.acquire();
      try {
        await executeAction(
          action,
          instances,
          configs,
          stateMap,
          issues,
          outcomes,
          dryRun,
        );
      } finally {
        release();
      }
    }),
  );
}

// ─── Action execution ────────────────────────────────────────────────────────

async function executeAction(
  action: ActionNode,
  instances: Map<string, ProviderPort>,
  configs: Map<string, Record<string, unknown>>,
  stateMap: Map<string, unknown>,
  issues: ResourceIssue[],
  outcomes: ResourceOutcome[],
  dryRun: boolean,
): Promise<void> {
  // Skip no-op and read actions — they don't need execution
  if (action.action === "no-op") {
    outcomes.push(
      succeed(action.resource, "no-op", stateMap.get(action.resource)),
    );
    return;
  }

  if (action.action === "read") {
    outcomes.push(
      succeed(action.resource, "read", stateMap.get(action.resource)),
    );
    return;
  }

  // Look up provider
  const provider = instances.get(action.provider);
  if (provider === undefined) {
    issues.push({
      resource: action.resource,
      message: `Provider instance "${action.provider}" not connected`,
    });
    outcomes.push(fail(action.resource, action.action, action.diff));
    return;
  }

  // Look up handler with scope resolution
  // First resolve refs to get a concrete spec, then resolve scopes from it
  let resolvedSpec = action.spec;
  if (isRecord(resolvedSpec)) {
    try {
      resolvedSpec = resolveRefs(resolvedSpec, stateMap);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown ref resolution error";
      issues.push({ resource: action.resource, message });
      outcomes.push(fail(action.resource, action.action, action.diff));
      return;
    }
  }

  const handlerPrototype = provider.resourceHandler(
    action.kind,
    ResolvedScopes.empty,
  );
  const providerConfig = configs.get(action.provider);
  const resolvedSpecForScopes = isRecord(resolvedSpec) ? resolvedSpec : {};
  const scopes = resolveScopes(
    handlerPrototype.scopes,
    resolvedSpecForScopes,
    providerConfig,
  );
  const handler = provider.resourceHandler(action.kind, scopes);

  // Dry run — don't apply
  if (dryRun) {
    outcomes.push(
      succeed(
        action.resource,
        action.action,
        stateMap.get(action.resource),
        action.diff,
      ),
    );
    return;
  }

  // Apply the action
  try {
    let result: unknown;

    if (action.action === "delete") {
      // Delete action — need the handler to support delete
      const currentState = stateMap.get(action.resource);
      if (currentState === undefined) {
        // Already absent — no-op
        outcomes.push(succeed(action.resource, "no-op", undefined));
        return;
      }

      // Check for delete support via the optional method
      if (handler.delete === undefined) {
        issues.push({
          resource: action.resource,
          message: `Resource kind "${action.kind}" does not implement delete()`,
        });
        outcomes.push(fail(action.resource, "delete", action.diff));
        return;
      }

      const stateId = action.stateId ?? handler.getStateId(currentState);
      await handler.delete(stateId);
      stateMap.set(action.resource, undefined);
      outcomes.push(succeed(action.resource, "delete", undefined, action.diff));
      return;
    }

    if (action.action === "create") {
      result = await handler.create(resolvedSpec);
    } else {
      // update
      const currentState = stateMap.get(action.resource);
      const stateId = action.stateId ?? handler.getStateId(currentState);
      result = await handler.update(stateId, resolvedSpec);
    }

    // Validate the response through state schema
    const responseResult = handler.stateSchema.safeParse(result);
    if (!responseResult.success) {
      issues.push(...collectZodIssues(action.resource, responseResult.error));
      outcomes.push(fail(action.resource, action.action, action.diff));
      return;
    }

    // Convergence verification (only for providers with convergenceDelay)
    const verification = await verifyConvergence(
      handler,
      resolvedSpec,
      responseResult.data,
      action.resource,
      issues,
    );

    if (!verification.verified) {
      outcomes.push(fail(action.resource, action.action, action.diff));
      return;
    }

    // Update state map with the verified state
    stateMap.set(action.resource, verification.state);
    outcomes.push(
      succeed(
        action.resource,
        action.action,
        verification.state,
        action.action === "update" ? action.diff : [],
      ),
    );
  } catch (err) {
    if (err instanceof ProviderApiError) {
      issues.push(
        ...err.issues.map((issue) => ({
          resource: action.resource,
          message: `${issue.path.map(String).join(".")}: ${issue.message}`,
        })),
      );
      outcomes.push(fail(action.resource, action.action, action.diff));
      return;
    }
    throw err;
  }
}

// ─── Action DAG topological sort ─────────────────────────────────────────────

/**
 * Topological sort of action nodes grouped by dependency level.
 * Action nodes at the same level have no dependencies between them
 * and can be processed concurrently.
 *
 * Uses Kahn's algorithm. Detects cycles.
 */
function topologicalSortActions(
  actions: readonly ActionNode[],
): ActionNode[][] {
  const nodeMap = new Map<string, ActionNode>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const action of actions) {
    const id = action.id;
    nodeMap.set(id, action);
    inDegree.set(id, action.deps.length);
    if (!dependents.has(id)) {
      dependents.set(id, []);
    }

    for (const dep of action.deps) {
      const list = dependents.get(dep);
      if (list !== undefined) {
        list.push(id);
      } else {
        dependents.set(dep, [id]);
      }
    }
  }

  const levels: ActionNode[][] = [];
  let queue: string[] = [];

  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const level: ActionNode[] = [];
    const nextQueue: string[] = [];

    for (const id of queue) {
      const node = nodeMap.get(id);
      if (node !== undefined) {
        level.push(node);
      }

      for (const dependent of dependents.get(id) ?? []) {
        const currentDegree = inDegree.get(dependent);
        if (currentDegree !== undefined) {
          const newDegree = currentDegree - 1;
          inDegree.set(dependent, newDegree);
          if (newDegree === 0) {
            nextQueue.push(dependent);
          }
        }
      }
    }

    if (level.length > 0) {
      levels.push(level);
    }
    queue = nextQueue;
  }

  return levels;
}
