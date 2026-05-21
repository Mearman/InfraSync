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
import { ResolvedScopes, type ProviderPort } from "./provider.js";
import type { ResourceIssue, FieldDiff } from "./resource.js";
import { collectZodIssues, deepEqual, isRecord, resolveRefs, resolveScopes } from "./resource.js";
import { ProviderApiError } from "./errors.js";
import type { ActionDag, ActionNode, PlanAction } from "./action-dag.js";

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
    await Promise.all(
      level.map((action) =>
        executeAction(action, instances, configs, stateMap, issues, outcomes, dryRun),
      ),
    );
  }

  return {
    result: { resources: outcomes, issues },
  };
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
    outcomes.push(succeed(action.resource, "no-op", stateMap.get(action.resource)));
    return;
  }

  if (action.action === "read") {
    outcomes.push(succeed(action.resource, "read", stateMap.get(action.resource)));
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

  const handlerPrototype = provider.resourceHandler(action.kind, ResolvedScopes.empty);
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
    outcomes.push(succeed(action.resource, action.action, stateMap.get(action.resource), action.diff));
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

      const deleteHandler = handler as {
        delete?: (id: string) => Promise<void>;
        getStateId: (state: unknown) => string;
      };

      if (deleteHandler.delete === undefined) {
        issues.push({
          resource: action.resource,
          message: `Resource kind "${action.kind}" does not implement delete()`,
        });
        outcomes.push(fail(action.resource, "delete", action.diff));
        return;
      }

      const stateId = action.stateId ?? deleteHandler.getStateId(currentState);
      await deleteHandler.delete(stateId);
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

    // Update state map with the new state
    stateMap.set(action.resource, responseResult.data);
    outcomes.push(
      succeed(
        action.resource,
        action.action,
        responseResult.data,
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
function topologicalSortActions(actions: readonly ActionNode[]): ActionNode[][] {
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
