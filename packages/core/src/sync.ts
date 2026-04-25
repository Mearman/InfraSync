import type { InfraIR } from "./types.js";
import type { ProviderAdapter, ProviderPort } from "./provider.js";
import type { DagNode } from "./dag.js";
import type { ResourceIssue } from "./resource.js";
import { buildDag, topologicalSortByLevel } from "./dag.js";
import { computePlan, type PlanAction } from "./plan.js";
import {
  collectZodIssues,
  deepEqual,
  resolveConfigSecrets,
  resolveRefs,
} from "./resource.js";
import { ProviderApiError } from "./errors.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** Controls whether the engine applies changes or only plans them. */
export interface SyncOptions {
  /** "plan" = read + plan only, "apply" = read + plan + apply. Default: "apply" */
  readonly mode?: "plan" | "apply";
}

/** Per-resource outcome from a sync run. */
export interface ResourceOutcome {
  readonly name: string;
  readonly action: PlanAction;
  readonly status: "success" | "failed";
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

    try {
      await this.connectProviders(ir, instances, issues);
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
              instances,
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
    issues: ResourceIssue[],
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
      const resolvedConfig = resolveConfigSecrets(provider.config);

      const result = instance.configSchema.safeParse(resolvedConfig);
      if (!result.success) {
        issues.push(
          ...collectZodIssues(`provider:${provider.key}`, result.error),
        );
        continue;
      }

      await instance.connect(resolvedConfig);
      instances.set(provider.key, instance);
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
    instances: Map<string, ProviderPort>,
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
      outcomes.push({ name: resource.name, action: "read", status: "failed" });
      return;
    }

    // Look up resource handler
    const handler = provider.resourceHandler(resource.kind);

    // 1. Resolve refs in the compiled spec
    let resolvedSpec: unknown;
    try {
      resolvedSpec = resolveRefs(resource.spec, stateMap);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown ref resolution error";
      issues.push({ resource: resource.name, message });
      outcomes.push({ name: resource.name, action: "read", status: "failed" });
      return;
    }

    // 2. Validate the resolved spec
    const specResult = handler.specSchema.safeParse(resolvedSpec);
    if (!specResult.success) {
      issues.push(...collectZodIssues(resource.name, specResult.error));
      outcomes.push({ name: resource.name, action: "read", status: "failed" });
      return;
    }

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
        outcomes.push({
          name: resource.name,
          action: "read",
          status: "failed",
        });
        return;
      }
      throw err;
    }

    // 4. Validate adapter output through state schema
    if (state !== undefined) {
      const stateResult = handler.stateSchema.safeParse(state);
      if (!stateResult.success) {
        issues.push(...collectZodIssues(resource.name, stateResult.error));
        outcomes.push({
          name: resource.name,
          action: "read",
          status: "failed",
        });
        return;
      }
      state = stateResult.data;
    }

    // Store state for downstream ref resolution
    stateMap.set(resource.name, state);

    // 5. Plan
    const action = computePlan(resource.mode, state);

    if (action === "read") {
      outcomes.push({ name: resource.name, action: "read", status: "success" });
      return;
    }

    // Check convergence for manage-mode resources
    if (action === "update" && state !== undefined) {
      const desiredResult = handler.desiredStateSchema.safeParse(resolvedSpec);
      const actualResult = handler.desiredStateSchema.safeParse(state);

      if (desiredResult.success && actualResult.success) {
        if (deepEqual(desiredResult.data, actualResult.data)) {
          outcomes.push({
            name: resource.name,
            action: "no-op",
            status: "success",
          });
          return;
        }
      } else {
        if (!desiredResult.success) {
          issues.push(...collectZodIssues(resource.name, desiredResult.error));
        }
        if (!actualResult.success) {
          issues.push(...collectZodIssues(resource.name, actualResult.error));
        }
        outcomes.push({
          name: resource.name,
          action: "update",
          status: "failed",
        });
        return;
      }
    }

    // 6. Apply (if not dry run)
    if (dryRun) {
      outcomes.push({ name: resource.name, action, status: "success" });
      return;
    }

    try {
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
        outcomes.push({ name: resource.name, action, status: "failed" });
        return;
      }

      // Update state map with the new state
      stateMap.set(resource.name, responseResult.data);
      outcomes.push({ name: resource.name, action, status: "success" });
    } catch (err) {
      if (err instanceof ProviderApiError) {
        issues.push(
          ...err.issues.map((issue) => ({
            resource: resource.name,
            message: `${issue.path.map(String).join(".")}: ${issue.message}`,
          })),
        );
        outcomes.push({ name: resource.name, action, status: "failed" });
        return;
      }
      throw err;
    }
  }
}
