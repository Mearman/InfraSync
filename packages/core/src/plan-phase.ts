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
import {
  ResolvedScopes,
  type ProviderPort,
  type ResourcePort,
} from "./provider.js";
import type { OrphanedResource } from "./provider.js";
import type { ResourceIssue, FieldDiff } from "./resource.js";
import { collectZodIssues, deepEqual, deepDiff, isRecord } from "./resource.js";
import type { StateMap } from "./state-map.js";
import type { ActionNode, ActionDag } from "./action-dag.js";
import type { PreconditionDeclaration } from "./transitions.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlanPhaseInput {
  readonly ir: InfraIR;
  readonly stateMap: StateMap;
  readonly instances: Map<string, ProviderPort>;
  readonly configs: Map<string, Record<string, unknown>>;
  /** Include ONLY resources matching any of these tags, plus their transitive dependencies */
  readonly tags?: readonly string[];
  /** Exclude resources matching any of these tags, unless depended on by an included resource */
  readonly skipTags?: readonly string[];
  /** Orphans detected during the read phase. */
  readonly orphans?: readonly OrphanedResource[];
  /** When true, produce delete actions for orphans. Otherwise report as issues. */
  readonly pruneOrphans?: boolean;
}

export interface PlanPhaseOutput {
  readonly actionDag: ActionDag;
  readonly issues: readonly ResourceIssue[];
}

/** Whether a resource is directly included (tagged), an ancestor (dependency), or excluded. */
interface TagFilterResult {
  /** Resources that should produce actions */
  readonly included: ReadonlySet<string>;
  /** Resources included only because they are dependencies — forced to read-only */
  readonly dependencyOnly: ReadonlySet<string>;
}

/**
 * Compute tag filtering: which resources are included and which are dependency-only.
 *
 * - `tags`: include ONLY resources with any matching tag, plus their transitive
 *   dependencies (walk the DAG backwards to include all ancestors).
 * - `skipTags`: exclude resources with matching tags, UNLESS they're in the
 *   dependency chain of an included resource.
 * - Untagged resources in the dependency chain of a tagged resource become
 *   read-only actions.
 * - Untagged resources NOT in any dependency chain are omitted entirely when
 *   `tags` is specified.
 * - When neither `tags` nor `skipTags` is specified, all resources are included.
 */
function computeTagFilter(
  resources: readonly ResourceIR[],
  tags: readonly string[] | undefined,
  skipTags: readonly string[] | undefined,
): TagFilterResult | undefined {
  // No filtering when neither option is provided
  if (
    (tags === undefined || tags.length === 0) &&
    (skipTags === undefined || skipTags.length === 0)
  ) {
    return undefined;
  }

  const tagSet = new Set(tags ?? []);
  const skipTagSet = new Set(skipTags ?? []);

  // Build name → resource lookup and dependency map
  const resourceByName = new Map<string, ResourceIR>();
  for (const resource of resources) {
    resourceByName.set(resource.name, resource);
  }

  // Build reverse dependency map: for each resource, who depends on it?
  // And forward dependency map: for each resource, what does it depend on?
  const forwardDeps = new Map<string, Set<string>>();
  for (const resource of resources) {
    const deps = new Set<string>();
    if (resource.refBindings !== undefined) {
      for (const binding of resource.refBindings) {
        deps.add(binding.targetResource);
      }
    }
    if (resource.dependsOn !== undefined) {
      for (const dep of resource.dependsOn) {
        deps.add(dep);
      }
    }
    forwardDeps.set(resource.name, deps);
  }

  // Walk the dependency graph backwards (from a resource to all its ancestors)
  // to collect transitive dependencies
  function collectAncestors(name: string, visited: Set<string>): void {
    const deps = forwardDeps.get(name);
    if (deps === undefined) return;
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visited.add(dep);
        collectAncestors(dep, visited);
      }
    }
  }

  const included = new Set<string>();
  const dependencyOnly = new Set<string>();

  if (tagSet.size > 0) {
    // Find resources that match any of the specified tags
    const directlyIncluded = new Set<string>();
    for (const resource of resources) {
      if (resource.tags !== undefined) {
        for (const tag of resource.tags) {
          if (tagSet.has(tag)) {
            directlyIncluded.add(resource.name);
            break;
          }
        }
      }
    }

    // Collect transitive dependencies of directly included resources
    const allAncestors = new Set<string>();
    for (const name of directlyIncluded) {
      collectAncestors(name, allAncestors);
    }

    // All directly included + their ancestors are included
    for (const name of directlyIncluded) {
      included.add(name);
    }
    for (const name of allAncestors) {
      included.add(name);
      // Ancestors not directly tagged are dependency-only (read actions)
      const resource = resourceByName.get(name);
      const isDirectlyTagged =
        resource?.tags?.some((t) => tagSet.has(t)) === true;
      if (!isDirectlyTagged) {
        dependencyOnly.add(name);
      }
    }
  } else {
    // No tags filter — include everything initially
    for (const resource of resources) {
      included.add(resource.name);
    }
  }

  // Apply skipTags: remove resources that have matching tags,
  // unless they are in the dependency chain of an included resource
  if (skipTagSet.size > 0) {
    // Recompute the set of resources that are dependencies of included resources
    const dependencyChains = new Set<string>();
    for (const name of included) {
      collectAncestors(name, dependencyChains);
    }

    for (const resource of resources) {
      if (resource.tags !== undefined) {
        const hasSkipTag = resource.tags.some((t) => skipTagSet.has(t));
        if (hasSkipTag) {
          // Keep if it's a dependency of an included resource
          const isDependedOn = dependencyChains.has(resource.name);
          // Also keep if it's directly included via tags
          const isDirectlyIncluded =
            tagSet.size > 0 && resource.tags.some((t) => tagSet.has(t));
          if (!isDependedOn && !isDirectlyIncluded) {
            included.delete(resource.name);
            dependencyOnly.delete(resource.name);
          }
        }
      }
    }
  }

  return { included, dependencyOnly };
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
  const { ir, stateMap, instances, tags, skipTags } = input;
  const issues: ResourceIssue[] = [];
  const actions: ActionNode[] = [];

  // Compute tag filtering before action computation
  const tagFilter = computeTagFilter(ir.resources, tags, skipTags);

  for (const resource of ir.resources) {
    // Apply tag filter — skip excluded resources
    if (tagFilter !== undefined) {
      if (!tagFilter.included.has(resource.name)) {
        continue;
      }

      // Force dependency-only resources to read mode
      if (
        tagFilter.dependencyOnly.has(resource.name) &&
        resource.mode === "manage"
      ) {
        const state = stateMap.get(resource.name);
        actions.push({
          id: nextId(resource.name),
          action: state === undefined ? "no-op" : "read",
          resource: resource.name,
          provider: resource.provider,
          kind: resource.kind,
          spec: rebuildSpec(resource),
          deps: collectDeps(resource),
        });
        continue;
      }
    }

    const provider = instances.get(resource.provider);
    if (provider === undefined) {
      issues.push({
        resource: resource.name,
        message: `Provider instance "${resource.provider}" not connected`,
      });
      continue;
    }

    const handler: ResourcePort = provider.resourceHandler(
      resource.kind,
      ResolvedScopes.empty,
    );

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
        stateId:
          baseAction.type === "update" && state !== undefined
            ? handler.getStateId(state)
            : undefined,
        diff: baseAction.diff !== undefined ? [...baseAction.diff] : undefined,
        deps: collectDeps(resource),
      });
    }
  }

  // Handle orphans detected during the read phase
  if (input.orphans !== undefined && input.orphans.length > 0) {
    if (input.pruneOrphans === true) {
      // Produce independent delete actions for each orphan
      for (const orphan of input.orphans) {
        // Find the provider key for this orphan's kind
        const providerKey = findProviderForKind(orphan.kind, instances);
        if (providerKey === undefined) {
          issues.push({
            resource: orphan.stateId,
            message: `Orphan of kind "${orphan.kind}" has no provider instance that supports it`,
          });
          continue;
        }

        actions.push({
          id: `orphan:delete:${orphan.stateId}`,
          action: "delete",
          resource: orphan.stateId,
          provider: providerKey,
          kind: orphan.kind,
          spec: null,
          deps: [],
        });
      }
    } else {
      // Report orphans as warnings/issues
      for (const orphan of input.orphans) {
        issues.push({
          resource: orphan.stateId,
          message: `Orphan detected: ${orphan.kind} resource not in IR (stateId: ${orphan.stateId})`,
        });
      }
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
): ActionNode[] | undefined {
  if (
    baseAction.type !== "update" ||
    baseAction.diff === undefined ||
    baseAction.diff.length === 0
  ) {
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
    );
    if (preconditionActions !== undefined) {
      return preconditionActions;
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

    if ("steps" in transition) {
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
          deps: buildDeps(prevId, resource),
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
        deps: buildDeps(prevId, resource),
      });

      return actions;
    }

    if ("computeSteps" in transition) {
      // Function form: call once during planning, freeze result into action nodes.
      // Documented as must-be-pure — no side effects, no closures over mutable state.
      const state = stateMap.get(resource.name);
      // The generic parameters default to z.ZodType which produces `any` for
      // inferred types. The actual runtime values are the spec and state objects.
      const computeStepsFn = transition.computeSteps;
      const steps = computeStepsFn(desiredSpec, state);

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
          deps: buildDeps(prevId, resource),
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
  matchOn: string | ((source: unknown, target: unknown) => boolean) | undefined,
  ir: InfraIR,
  instances: Map<string, ProviderPort>,
): ResourceIR[] {
  const matched: ResourceIR[] = [];

  for (const resource of ir.resources) {
    // Skip the source resource itself
    if (resource.name === sourceResource.name) continue;

    // Get the handler for this resource
    const provider = instances.get(resource.provider);
    if (provider === undefined) continue;

    const handler = provider.resourceHandler(
      resource.kind,
      ResolvedScopes.empty,
    );

    // Compare schema identity
    if (handler.specSchema !== targetSchema) continue;

    // If matchOn is specified, check matching
    if (matchOn !== undefined) {
      const sourceSpec = rebuildSpec(sourceResource);
      const targetSpec = rebuildSpec(resource);

      if (typeof matchOn === "function") {
        // Function form: pure predicate
        if (!matchOn(sourceSpec, targetSpec)) continue;
      } else {
        // String form: field equality
        const sourceValue = isRecord(sourceSpec)
          ? sourceSpec[matchOn]
          : undefined;
        const targetValue = isRecord(targetSpec)
          ? targetSpec[matchOn]
          : undefined;

        if (sourceValue !== targetValue) continue;
      }
    }

    matched.push(resource);
  }

  return matched;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildDeps(prevId: string | undefined, resource: ResourceIR): string[] {
  if (prevId !== undefined) return [prevId];
  return collectDeps(resource);
}

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

/**
 * Find the provider instance key that supports a given resource kind.
 * Returns the first matching provider key, or undefined if none found.
 */
function findProviderForKind(
  kind: string,
  instances: Map<string, ProviderPort>,
): string | undefined {
  for (const [key, provider] of instances) {
    if (provider.supportedKinds().includes(kind)) return key;
  }
  return undefined;
}
