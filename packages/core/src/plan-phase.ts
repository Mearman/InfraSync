/**
 * Phase 2: Plan actions for all resources.
 *
 * Compares current state against desired config. For each resource,
 * produces an action (create, update, delete, no-op, read). Evaluates
 * transitions and preconditions, expanding single-resource updates
 * into multi-step action sequences.
 *
 * Pure function of (InfraIR, StateMap, adapters).
 * Deterministic: same inputs → same ActionDag.
 */
import * as crypto from "node:crypto";
import type * as z from "zod";
import type { InfraIR, ResourceIR } from "./types.js";
import { ResolvedScopes, type ProviderPort, type ResourcePort } from "./provider.js";
import type { ResourceIssue, FieldDiff } from "./resource.js";
import { collectZodIssues, deepEqual, deepDiff, isRecord } from "./resource.js";
import type { StateMap } from "./state-map.js";
import type { ActionNode, ActionDag } from "./action-dag.js";
import type { PreconditionDeclaration } from "./transitions.js";
import {
  matchGuards,
  planTransitions,
  type TransitionStep,
  type ConvergenceGuard,
} from "./convergence-guards.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlanPhaseInput {
  readonly ir: InfraIR;
  readonly stateMap: StateMap;
  readonly instances: Map<string, ProviderPort>;
  readonly configs: Map<string, Record<string, unknown>>;
}

export interface PlanPhaseOutput {
  readonly actionDag: ActionDag;
  readonly issues: readonly ResourceIssue[];
}

// ─── Plan phase ──────────────────────────────────────────────────────────────

function nextId(resource: string): string {
  return resource;
}
/**
 * Phase 2: Plan actions for all resources.
 *
 * Pure function of (InfraIR, StateMap, instances).
 * Deterministic: same inputs → same ActionDag.
 */
export function planPhase(input: PlanPhaseInput): PlanPhaseOutput {
  const { ir, stateMap, instances } = input;
  const issues: ResourceIssue[] = [];
  const actions: ActionNode[] = [];

  for (const resource of ir.resources) {
    const provider = instances.get(resource.provider);
    if (provider === undefined) {
      issues.push({
        resource: resource.name,
        message: `Provider instance "${resource.provider}" not connected`,
      });
      continue;
    }

    const handler: ResourcePort = provider.resourceHandler(resource.kind, ResolvedScopes.empty);

    // Compute the base action for this resource
    const state = stateMap.get(resource.name);
    const baseAction = computeBaseAction(resource, state, handler, issues);

    if (baseAction === undefined) {
      continue;
    }

    if (baseAction.type === "read") {
      actions.push({
        id: nextId(resource.name),
        action: "read",
        resource: resource.name,
        provider: resource.provider,
        kind: resource.kind,
        spec: resource.spec,
        deps: collectDeps(resource),
      });
      continue;
    }

    if (baseAction.type === "no-op") {
      actions.push({
        id: nextId(resource.name),
        action: "no-op",
        resource: resource.name,
        provider: resource.provider,
        kind: resource.kind,
        spec: resource.spec,
        deps: collectDeps(resource),
      });
      continue;
    }

    // For create/update, check if transitions or convergence guards apply
    const guardActions = evaluateGuards(
      resource,
      baseAction,
      handler,
      ir,
      stateMap,
      instances,
      issues,
    );

    if (guardActions !== undefined) {
      actions.push(...guardActions);
    } else {
      actions.push({
        id: nextId(resource.name),
        action: baseAction.type,
        resource: resource.name,
        provider: resource.provider,
        kind: resource.kind,
        spec: rebuildSpec(resource),
        stateId: baseAction.type === "update" && state !== undefined
          ? handler.getStateId(state)
          : undefined,
        diff: baseAction.diff !== undefined ? [...baseAction.diff] : undefined,
        deps: collectDeps(resource),
      });
    }
  }

  const actionDag: ActionDag = {
    actions,
    planTimestamp: new Date().toISOString(),
    infraIRHash: hashJSON(ir),
    stateMapHash: hashJSON(stateMap.toJSON()),
  };

  return { actionDag, issues };
}

// ─── Base action computation ─────────────────────────────────────────────────

interface BaseAction {
  readonly type: "create" | "update" | "no-op" | "read";
  readonly diff?: readonly FieldDiff[];
}

function computeBaseAction(
  resource: ResourceIR,
  state: unknown,
  handler: ResourcePort,
  issues: ResourceIssue[],
): BaseAction | undefined {
  if (resource.mode === "read") {
    return { type: "read" };
  }

  if (state === undefined) {
    return { type: "create" };
  }

  const normalisedState =
    handler.codec !== undefined ? handler.codec.encode(state) : state;

  const spec = rebuildSpec(resource);
  const desiredResult = handler.desiredStateSchema.safeParse(spec);
  const actualResult = handler.desiredStateSchema.safeParse(normalisedState);

  if (!desiredResult.success) {
    issues.push(...collectZodIssues(resource.name, desiredResult.error));
    return undefined;
  }
  if (!actualResult.success) {
    issues.push(...collectZodIssues(resource.name, actualResult.error));
    return undefined;
  }

  if (deepEqual(desiredResult.data, actualResult.data)) {
    return { type: "no-op" };
  }

  return {
    type: "update",
    diff: deepDiff(desiredResult.data, actualResult.data),
  };
}

// ─── Guard evaluation ────────────────────────────────────────────────────────

function evaluateGuards(
  resource: ResourceIR,
  baseAction: BaseAction,
  handler: ResourcePort,
  ir: InfraIR,
  stateMap: StateMap,
  instances: Map<string, ProviderPort>,
  issues: ResourceIssue[],
): ActionNode[] | undefined {
  if (baseAction.type !== "update" || baseAction.diff === undefined || baseAction.diff.length === 0) {
    return undefined;
  }

  // Check typed transitions (new system)
  if (handler.transitions !== undefined && handler.transitions.length > 0) {
    const transitionActions = evaluateTransitions(
      resource,
      baseAction,
      handler,
      stateMap,
    );
    if (transitionActions !== undefined) {
      return transitionActions;
    }
  }

  // Check typed preconditions (new system)
  if (handler.preconditions !== undefined && handler.preconditions.length > 0) {
    const preconditionActions = evaluatePreconditions(
      resource,
      baseAction,
      handler.preconditions,
      ir,
      stateMap,
      instances,
      issues,
    );
    if (preconditionActions !== undefined) {
      return preconditionActions;
    }
  }

  // Fall back to legacy convergence guards
  if (handler.convergenceGuards !== undefined && handler.convergenceGuards.length > 0) {
    const legacyActions = evaluateLegacyGuards(
      resource,
      baseAction,
      handler.convergenceGuards,
      ir,
      stateMap,
      issues,
    );
    if (legacyActions !== undefined) {
      return legacyActions;
    }
  }

  return undefined;
}

/**
 * Evaluate typed transitions.
 */
function evaluateTransitions(
  resource: ResourceIR,
  baseAction: BaseAction,
  handler: ResourcePort,
  stateMap: StateMap,
): ActionNode[] | undefined {
  const divergentFields = (baseAction.diff ?? []).map((d) => d.path);
  let stepCounter = 0;

  for (const transition of handler.transitions ?? []) {
    const triggered = transition.guardFields.some((f: string) =>
      divergentFields.some((df) => df === f || df.startsWith(`${f}.`)),
    );

    if (!triggered) continue;

    const desiredSpec = rebuildSpec(resource);

    if ("steps" in transition && transition.steps !== undefined) {
      const actions: ActionNode[] = [];
      let prevId: string | undefined;

      for (const overlay of transition.steps) {
        const stepSpec = isRecord(desiredSpec)
          ? { ...desiredSpec, ...overlay }
          : overlay;

        const stepId = `transition:${resource.name}:${String(stepCounter++)}`;
        actions.push({
          id: stepId,
          action: "update",
          resource: resource.name,
          provider: resource.provider,
          kind: resource.kind,
          spec: stepSpec,
          deps: prevId !== undefined ? [prevId] : collectDeps(resource),
        });
        prevId = stepId;
      }

      const finalId = `transition:${resource.name}:${String(stepCounter++)}`;
      actions.push({
        id: finalId,
        action: "update",
        resource: resource.name,
        provider: resource.provider,
        kind: resource.kind,
        spec: desiredSpec,
        diff: baseAction.diff !== undefined ? [...baseAction.diff] : undefined,
        deps: prevId !== undefined ? [prevId] : collectDeps(resource),
      });

      return actions;
    }

    if ("computeSteps" in transition && transition.computeSteps !== undefined) {
      // Function form: call once during planning, freeze result into action nodes.
      // Documented as must-be-pure — no side effects, no closures over mutable state.
      const state = stateMap.get(resource.name);
      const steps = transition.computeSteps(
        desiredSpec as never,
        state as never,
      );

      const actions: ActionNode[] = [];
      let prevId: string | undefined;

      for (const stepSpec of steps) {
        const stepId = `transition:${resource.name}:${String(stepCounter++)}`;
        actions.push({
          id: stepId,
          action: "update",
          resource: resource.name,
          provider: resource.provider,
          kind: resource.kind,
          spec: stepSpec,
          deps: prevId !== undefined ? [prevId] : collectDeps(resource),
        });
        prevId = stepId;
      }

      return actions;
    }
  }

  return undefined;
}

/**
 * Evaluate legacy convergence guards — translates to action nodes.
 */
/**
 * Evaluate typed preconditions — cross-resource ordering constraints.
 *
 * For each precondition, resolves the target schema to matching resources
 * in the IR, checks the guard fields, and produces delete/create action
 * nodes to ensure the target is in the required state before the
 * guarded update runs.
 */
function evaluatePreconditions(
  resource: ResourceIR,
  baseAction: BaseAction,
  preconditions: readonly PreconditionDeclaration[],
  ir: InfraIR,
  stateMap: StateMap,
  instances: Map<string, ProviderPort>,
  issues: ResourceIssue[],
): ActionNode[] | undefined {
  const divergentFields = new Set((baseAction.diff ?? []).map((d) => d.path));

  for (const precondition of preconditions) {
    // Check if any guard fields diverge
    const triggered = precondition.guardFields.some((f) =>
      divergentFields.has(f),
    );
    if (!triggered) continue;

    // Resolve target schema to matching resources in the IR
    const matchedResources = resolveTargetResources(
      precondition.target,
      resource,
      precondition.matchOn,
      ir,
      instances,
      issues,
    );

    if (matchedResources.length === 0) continue;

    // For each matched target resource, produce ordering actions
    const actions: ActionNode[] = [];
    let lastDep: string | undefined;

    for (const targetResource of matchedResources) {
      const targetState = stateMap.get(targetResource.name);

      if (precondition.required === "absent" && targetState !== undefined) {
        // Target must be absent — delete it first
        const deleteId = `precondition:delete:${targetResource.name}`;
        actions.push({
          id: deleteId,
          action: "delete",
          resource: targetResource.name,
          provider: targetResource.provider,
          kind: targetResource.kind,
          spec: null,
          deps: [],
        });
        lastDep = deleteId;
      }

      if (precondition.required === "present" && targetState === undefined) {
        // Target must be present — create it first
        const createId = `precondition:create:${targetResource.name}`;
        actions.push({
          id: createId,
          action: "create",
          resource: targetResource.name,
          provider: targetResource.provider,
          kind: targetResource.kind,
          spec: targetResource.spec,
          deps: [],
        });
        lastDep = createId;
      }
    }

    // The guarded update itself
    const updateId = `precondition:update:${resource.name}`;
    actions.push({
      id: updateId,
      action: "update",
      resource: resource.name,
      provider: resource.provider,
      kind: resource.kind,
      spec: rebuildSpec(resource),
      diff: baseAction.diff !== undefined ? [...baseAction.diff] : undefined,
      deps: [
        ...collectDeps(resource),
        ...(lastDep !== undefined ? [lastDep] : []),
      ],
    });

    // Restore targets after the guarded update
    for (const targetResource of matchedResources) {
      const targetState = stateMap.get(targetResource.name);

      if (precondition.required === "absent" && targetState !== undefined) {
        // Recreate the target after the guarded update
        const recreateId = `precondition:recreate:${targetResource.name}`;
        actions.push({
          id: recreateId,
          action: "create",
          resource: targetResource.name,
          provider: targetResource.provider,
          kind: targetResource.kind,
          spec: targetResource.spec,
          deps: [updateId],
        });
      }
    }

    if (actions.length > 0) return actions;
  }

  return undefined;
}

/**
 * Resolve a target schema to matching resources in the IR.
 *
 * Compares the precondition's `target` schema against each resource's
 * handler's `specSchema` using identity (===). If `matchOn` is specified,
 * filters to resources where the source and target match on that field.
 */
function resolveTargetResources(
  targetSchema: z.ZodType,
  sourceResource: ResourceIR,
  matchOn: string | undefined,
  ir: InfraIR,
  instances: Map<string, ProviderPort>,
  _issues: ResourceIssue[],
): ResourceIR[] {
  const matched: ResourceIR[] = [];

  for (const resource of ir.resources) {
    // Skip the source resource itself
    if (resource.name === sourceResource.name) continue;

    // Get the handler for this resource
    const provider = instances.get(resource.provider);
    if (provider === undefined) continue;

    const handler = provider.resourceHandler(resource.kind, ResolvedScopes.empty);

    // Compare schema identity
    if (handler.specSchema !== targetSchema) continue;

    // If matchOn is specified, check field equality
    if (matchOn !== undefined) {
      const sourceSpec = rebuildSpec(sourceResource);
      const targetSpec = rebuildSpec(resource);

      const sourceValue = isRecord(sourceSpec) ? sourceSpec[matchOn] : undefined;
      const targetValue = isRecord(targetSpec) ? targetSpec[matchOn] : undefined;

      if (sourceValue !== targetValue) continue;
    }

    matched.push(resource);
  }

  return matched;
}

function evaluateLegacyGuards(
  resource: ResourceIR,
  baseAction: BaseAction,
  guards: readonly ConvergenceGuard[],
  ir: InfraIR,
  stateMap: StateMap,
  _issues: ResourceIssue[],
): ActionNode[] | undefined {
  const resolvedSpec = rebuildSpec(resource);

  // matchGuards expects a Map<string, unknown> for stateMap
  const stateMapAsMap = new Map<string, unknown>();
  for (const [key, value] of Object.entries(stateMap.toJSON())) {
    stateMapAsMap.set(key, value);
  }

  const matched = matchGuards(
    guards,
    baseAction.diff ?? [],
    resolvedSpec,
    ir.resources,
    stateMapAsMap,
  );

  if (matched.length === 0) return undefined;

  const guardSteps = planTransitions(matched, ir.resources);
  if (guardSteps === undefined) return undefined;

  const actions: ActionNode[] = [];
  let lastPreId: string | undefined;

  // Delete steps
  const deleteSteps = guardSteps.filter(
    (s): s is TransitionStep & { type: "delete" } => s.type === "delete",
  );
  for (const step of deleteSteps) {
    const stepState = stateMap.get(step.resourceName);
    if (stepState === undefined) continue;

    const deleteId = `guard:delete:${step.resourceName}`;
    actions.push({
      id: deleteId,
      action: "delete",
      resource: step.resourceName,
      provider: step.provider,
      kind: step.kind,
      spec: null,
      stateId: undefined, // Will be populated by executor at runtime
      deps: [],
    });
    lastPreId = deleteId;
  }

  // The guarded update itself
  const updateId = `guard:update:${resource.name}`;
  actions.push({
    id: updateId,
    action: "update",
    resource: resource.name,
    provider: resource.provider,
    kind: resource.kind,
    spec: resolvedSpec,
    diff: baseAction.diff !== undefined ? [...baseAction.diff] : undefined,
    deps: lastPreId !== undefined ? [lastPreId] : collectDeps(resource),
  });

  // Recreate steps
  const recreateSteps = guardSteps.filter(
    (s): s is TransitionStep & { type: "recreate" } => s.type === "recreate",
  );
  let lastId: string = updateId;
  for (const step of recreateSteps) {
    const recreateId = `guard:recreate:${step.resourceName}`;
    actions.push({
      id: recreateId,
      action: "create",
      resource: step.resourceName,
      provider: step.provider,
      kind: step.kind,
      spec: step.spec,
      deps: [lastId],
    });
    lastId = recreateId;
  }

  return actions;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collectDeps(resource: ResourceIR): string[] {
  const deps: string[] = [];

  if (resource.refBindings !== undefined) {
    for (const binding of resource.refBindings) {
      deps.push(binding.targetResource);
    }
  }

  if (resource.dependsOn !== undefined) {
    for (const dep of resource.dependsOn) {
      deps.push(dep);
    }
  }

  return deps;
}

function rebuildSpec(resource: ResourceIR): Record<string, unknown> {
  return {
    ...resource.spec,
    kind: resource.kind,
    name: resource.name,
  };
}

function hashJSON(value: unknown): string {
  const serialised = JSON.stringify(value);
  return crypto.createHash("sha256").update(serialised).digest("hex");
}
