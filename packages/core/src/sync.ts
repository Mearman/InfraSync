import type { InfraIR } from "./types.js";
import {
  ResolvedScopes,
  type ProviderAdapter,
  type ProviderPort,
} from "./provider.js";
import type { DagNode } from "./dag.js";
import type { ResourceIssue, FieldDiff } from "./resource.js";
import { buildDag, topologicalSortByLevel } from "./dag.js";
import { computePlan, type PlanAction } from "./plan.js";
import {
  collectZodIssues,
  deepEqual,
  deepDiff,
  isRecord,
  resolveConfigSecrets,
  resolveRefs,
  resolveScopes,
  envSecretResolver,
} from "./resource.js";
import type { SecretResolver } from "./resource.js";
import { ProviderApiError } from "./errors.js";
import type { ResourceCache } from "./cache.js";
import { CachedProviderPort } from "./cache.js";
import {
  matchGuards,
  planTransitions,
  type TransitionStep,
} from "./convergence-guards.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** Controls whether the engine applies changes or only plans them. */
export interface SyncOptions {
  /** "plan" = read + plan only, "apply" = read + plan + apply. Default: "apply" */
  readonly mode?: "plan" | "apply";
  /** Secret resolver. Defaults to envSecretResolver (reads from process.env). */
  readonly secretResolver?: SecretResolver;
  /** Optional cache for provider read results. When provided, wraps all provider instances. */
  readonly cache?: ResourceCache;
  /** Cache TTL in milliseconds for this run. Default: cache.defaultTtl */
  readonly cacheTtl?: number;
}

/** Per-resource outcome from a sync run. */
export interface ResourceOutcome {
  readonly name: string;
  readonly action: PlanAction;
  readonly status: "success" | "failed";
  /**
   * The provider state for this resource.
   *
   * For read-mode: the current state from the provider.
   * For manage-mode: the state after create/update, or the current state
   * if no changes were needed (no-op). Undefined if the read failed or
   * the resource didn't exist and mode was "read".
   */
  readonly state: unknown;
  /**
   * Field-level diff between desired and actual state.
   *
   * Only populated when action is "update" — shows which fields diverged
   * between the desired spec and the current provider state.
   * Empty for create, read, no-op, and failed outcomes.
   */
  readonly diff: readonly FieldDiff[];
}

// ─── Outcome factory ─────────────────────────────────────────────────────────

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

/** The result of a sync execution. */
export interface SyncResult {
  /** Per-resource outcomes */
  readonly resources: readonly ResourceOutcome[];
  /** Validation issues encountered across all resources */
  readonly issues: readonly ResourceIssue[];
}

// ─── SyncEngine ──────────────────────────────────────────────────────────────

/**
 * The main sync engine. Consumes a compiled InfraIR and executes the
 * read → plan → apply cycle.
 *
 * Usage:
 *
 * ```typescript
 * const engine = new SyncEngine(adapters);
 * const result = await engine.execute(ir, { mode: "plan" });
 * ```
 */
export class SyncEngine {
  constructor(private readonly adapters: Map<string, ProviderAdapter>) {}

  async execute(ir: InfraIR, options?: SyncOptions): Promise<SyncResult> {
    const dryRun = options?.mode === "plan";
    const issues: ResourceIssue[] = [];
    const outcomes: ResourceOutcome[] = [];

    // 1. Create and connect adapter instances
    const instances = new Map<string, ProviderPort>();
    const configs = new Map<string, Record<string, unknown>>();

    try {
      const secretResolver = options?.secretResolver ?? envSecretResolver;

      await this.connectProviders(
        ir,
        instances,
        configs,
        issues,
        secretResolver,
        options?.cache,
        options?.cacheTtl,
      );
      if (issues.length > 0) {
        return { resources: [], issues };
      }

      // 2. Build DAG and topological sort
      const dag = buildDag(ir.resources);
      const levels = topologicalSortByLevel(dag);

      // 3. Process resources level by level (parallel within each level)
      const stateMap = new Map<string, unknown>();

      for (const level of levels) {
        await Promise.all(
          level.map((node) =>
            this.processNode(
              node,
              ir,
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

      return { resources: outcomes, issues };
    } finally {
      await this.disconnectProviders(instances);
    }
  }

  // ─── Provider lifecycle ────────────────────────────────────────────────────

  private async connectProviders(
    ir: InfraIR,
    instances: Map<string, ProviderPort>,
    configs: Map<string, Record<string, unknown>>,
    issues: ResourceIssue[],
    secretResolver: SecretResolver,
    cache: ResourceCache | undefined,
    cacheTtl: number | undefined,
  ): Promise<void> {
    for (const provider of ir.providers) {
      const adapter = this.adapters.get(provider.adapterName);
      if (adapter === undefined) {
        issues.push({
          resource: provider.key,
          message: `Unknown adapter: "${provider.adapterName}" — no adapter registered with that name`,
        });
        continue;
      }

      const instance = adapter.create();
      const resolvedConfig = resolveConfigSecrets(
        provider.config,
        secretResolver,
      );

      const result = instance.configSchema.safeParse(resolvedConfig);
      if (!result.success) {
        issues.push(
          ...collectZodIssues(`provider:${provider.key}`, result.error),
        );
        continue;
      }

      await instance.connect(resolvedConfig);

      // Wrap with cache if configured
      const maybeCached =
        cache !== undefined
          ? new CachedProviderPort(
              instance,
              cache,
              cacheTtl !== undefined ? { ttl: cacheTtl } : undefined,
            )
          : instance;

      instances.set(provider.key, maybeCached);
      if (isRecord(result.data)) {
        configs.set(provider.key, result.data);
      }
    }
  }
  private async disconnectProviders(
    instances: Map<string, ProviderPort>,
  ): Promise<void> {
    const disconnectResults = await Promise.allSettled(
      [...instances.values()].map((instance) => instance.disconnect()),
    );

    for (const result of disconnectResults) {
      if (result.status === "rejected") {
        // Log but don't fail — disconnect errors are non-fatal
        console.error("Failed to disconnect provider:", result.reason);
      }
    }
  }

  // ─── Resource processing ───────────────────────────────────────────────────

  private async processNode(
    node: DagNode,
    ir: InfraIR,
    instances: Map<string, ProviderPort>,
    configs: Map<string, Record<string, unknown>>,
    stateMap: Map<string, unknown>,
    issues: ResourceIssue[],
    outcomes: ResourceOutcome[],
    dryRun: boolean,
  ): Promise<void> {
    const { resource } = node;

    // Look up provider instance
    const provider = instances.get(resource.provider);
    if (provider === undefined) {
      issues.push({
        resource: resource.name,
        message: `Provider instance "${resource.provider}" not connected`,
      });
      outcomes.push(fail(resource.name, "read"));
      return;
    }

    // Look up resource handler — first get the prototype to read scope declarations
    const handlerPrototype = provider.resourceHandler(
      resource.kind,
      ResolvedScopes.empty,
    );

    // 1. Resolve refs in the compiled spec
    let resolvedSpec: unknown;
    try {
      resolvedSpec = resolveRefs(resource.spec, stateMap);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown ref resolution error";
      issues.push({ resource: resource.name, message });
      outcomes.push(fail(resource.name, "read"));
      return;
    }

    // 1b. Inject identity fields from the IR into the resolved spec.
    // Declarative resources compile with kind/name stripped from spec,
    // but handler spec schemas require them. The engine re-injects
    // from the IR — these are structural, not user-supplied.
    if (isRecord(resolvedSpec)) {
      if (!("kind" in resolvedSpec)) resolvedSpec.kind = resource.kind;
      if (!("name" in resolvedSpec)) resolvedSpec.name = resource.name;
    } else {
      // Spec is empty or non-object — construct minimal spec with identity fields
      resolvedSpec = { kind: resource.kind, name: resource.name };
    }

    // 2. Validate the resolved spec
    const specResult = handlerPrototype.specSchema.safeParse(resolvedSpec);
    if (!specResult.success) {
      issues.push(...collectZodIssues(resource.name, specResult.error));
      outcomes.push(fail(resource.name, "read"));
      return;
    }

    // 2b. Resolve scopes and create the real handler with them injected
    const providerConfig = configs.get(resource.provider);
    const scopes = resolveScopes(
      handlerPrototype.scopes,
      resolvedSpec,
      providerConfig,
    );
    const handler = provider.resourceHandler(resource.kind, scopes);

    // 3. Read current state from the provider
    let state: unknown;
    try {
      state = await handler.read(resolvedSpec);
    } catch (err) {
      if (err instanceof ProviderApiError) {
        issues.push(
          ...err.issues.map((issue) => ({
            resource: resource.name,
            message: `${issue.path.map(String).join(".")}: ${issue.message}`,
          })),
        );
        outcomes.push(fail(resource.name, "read"));
        return;
      }
      throw err;
    }

    // 4. Validate adapter output through state schema
    if (state !== undefined) {
      const stateResult = handler.stateSchema.safeParse(state);
      if (!stateResult.success) {
        issues.push(...collectZodIssues(resource.name, stateResult.error));
        outcomes.push(fail(resource.name, "read"));
        return;
      }
      state = stateResult.data;
    }

    // Store state for downstream ref resolution
    stateMap.set(resource.name, state);

    // 5. Plan
    const action = computePlan(resource.mode, state);

    if (action === "read") {
      outcomes.push(succeed(resource.name, "read", state));
      return;
    }

    // Check convergence for manage-mode resources
    let updateDiff: readonly FieldDiff[] = [];
    if (action === "update" && state !== undefined) {
      // Normalise provider state through the codec if one exists,
      // so convergence checking compares apples to apples.
      const normalisedState =
        handler.codec !== undefined ? handler.codec.encode(state) : state;

      const desiredResult = handler.desiredStateSchema.safeParse(resolvedSpec);
      const actualResult =
        handler.desiredStateSchema.safeParse(normalisedState);

      if (desiredResult.success && actualResult.success) {
        if (deepEqual(desiredResult.data, actualResult.data)) {
          outcomes.push(succeed(resource.name, "no-op", state));
          return;
        }
        // Compute field-level diff for the update action
        updateDiff = deepDiff(desiredResult.data, actualResult.data);
      } else {
        if (!desiredResult.success) {
          issues.push(...collectZodIssues(resource.name, desiredResult.error));
        }
        if (!actualResult.success) {
          issues.push(...collectZodIssues(resource.name, actualResult.error));
        }
        outcomes.push(fail(resource.name, "update"));
        return;
      }
    }

    // 6. Apply (if not dry run)
    if (dryRun) {
      outcomes.push(succeed(resource.name, action, state));
      return;
    }

    try {
      // 6a. Check convergence guards — if the update has divergent fields
      // that trigger a guard, the engine must transition prerequisite
      // resources before applying the update, then restore them after.
      const guards = handler.convergenceGuards;
      let guardSteps: TransitionStep[] | undefined;

      if (
        action === "update" &&
        guards !== undefined &&
        guards.length > 0 &&
        updateDiff.length > 0
      ) {
        const matched = matchGuards(
          guards,
          updateDiff,
          resolvedSpec,
          ir.resources,
          stateMap,
        );

        if (matched.length > 0) {
          guardSteps = planTransitions(matched, ir.resources);
        }
      }

      // 6b. If guards triggered, execute delete phase first
      if (guardSteps !== undefined) {
        const deleteSteps = guardSteps.filter(
          (s): s is TransitionStep & { type: "delete" } => s.type === "delete",
        );

        for (const step of deleteSteps) {
          const stepProvider = instances.get(step.provider);
          if (stepProvider === undefined) {
            issues.push({
              resource: step.resourceName,
              message: `Provider "${step.provider}" not connected for guard transition`,
            });
            outcomes.push(fail(resource.name, action, updateDiff));
            return;
          }

          const stepHandler = stepProvider.resourceHandler(
            step.kind,
            ResolvedScopes.empty,
          );

          if (stepHandler.delete === undefined) {
            issues.push({
              resource: step.resourceName,
              message: `Resource kind "${step.kind}" does not implement delete() — required for convergence guard`,
            });
            outcomes.push(fail(resource.name, action, updateDiff));
            return;
          }

          const stepState = stateMap.get(step.resourceName);
          if (stepState !== undefined) {
            const stepStateId = stepHandler.getStateId(stepState);
            await stepHandler.delete(stepStateId);
            stateMap.set(step.resourceName, undefined);
          }
        }
      }

      // 6c. Apply the guarded (or normal) update
      let result: unknown;

      if (action === "create") {
        result = await handler.create(resolvedSpec);
      } else {
        // action === "update"
        const stateId = handler.getStateId(state);
        result = await handler.update(stateId, resolvedSpec);
      }

      // Validate the create/update response through state schema
      const responseResult = handler.stateSchema.safeParse(result);
      if (!responseResult.success) {
        issues.push(...collectZodIssues(resource.name, responseResult.error));
        outcomes.push(fail(resource.name, action, updateDiff));
        // Don't proceed with recreation if the guarded update failed
        return;
      }

      // Update state map with the new state
      stateMap.set(resource.name, responseResult.data);

      // 6d. If guards triggered, recreate deleted prerequisite resources
      if (guardSteps !== undefined) {
        const recreateSteps = guardSteps.filter(
          (s): s is TransitionStep & { type: "recreate" } =>
            s.type === "recreate",
        );

        for (const step of recreateSteps) {
          const stepProvider = instances.get(step.provider);
          if (stepProvider === undefined) continue; // Already reported above

          const stepHandler = stepProvider.resourceHandler(
            step.kind,
            ResolvedScopes.empty,
          );

          // Resolve refs in the prerequisite spec
          let stepSpec: unknown;
          try {
            stepSpec = resolveRefs(
              isRecord(step.spec) ? step.spec : {},
              stateMap,
            );
          } catch {
            // If refs can't be resolved, use the raw spec
            stepSpec = step.spec;
          }

          // Inject identity fields
          if (isRecord(stepSpec)) {
            if (!("kind" in stepSpec)) stepSpec.kind = step.kind;
            if (!("name" in stepSpec)) stepSpec.name = step.resourceName;
          }

          try {
            const recreateResult = await stepHandler.create(stepSpec);
            const recreateValidated =
              stepHandler.stateSchema.safeParse(recreateResult);
            if (recreateValidated.success) {
              stateMap.set(step.resourceName, recreateValidated.data);
            }
          } catch (err) {
            if (err instanceof ProviderApiError) {
              issues.push(
                ...err.issues.map((issue) => ({
                  resource: step.resourceName,
                  message: `${issue.path.map(String).join(".")}: ${issue.message}`,
                })),
              );
            }
            // Don't fail the guarded resource — the recreation is a
            // best-effort restore. The guarded update already succeeded.
          }
        }
      }

      outcomes.push(
        succeed(
          resource.name,
          action,
          responseResult.data,
          action === "update" ? updateDiff : [],
        ),
      );
    } catch (err) {
      if (err instanceof ProviderApiError) {
        issues.push(
          ...err.issues.map((issue) => ({
            resource: resource.name,
            message: `${issue.path.map(String).join(".")}: ${issue.message}`,
          })),
        );
        outcomes.push(fail(resource.name, action));
        return;
      }
      throw err;
    }
  }
}
