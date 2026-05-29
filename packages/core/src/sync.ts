/**
 * SyncEngine — thin orchestrator for the three-phase pipeline.
 *
 * Phase 1: Read current state → StateMap
 * Phase 2: Plan actions → ActionDag
 * Phase 3: Execute actions → SyncResult
 *
 * Every phase boundary produces serialisable data. The engine delegates
 * to the phase modules and handles provider lifecycle.
 */
import type { InfraIR } from "./types.js";
import type { ProviderAdapter } from "./provider.js";
import type { ResourceIssue, FieldDiff, SecretResolver } from "./resource.js";
import type { ResourceCache } from "./cache.js";
import type { PlanAction } from "./action-dag.js";
import type { ActionDag } from "./action-dag.js";
import type { InfraHandler, HandlerOutcome } from "./handlers.js";
import { executeHandlers } from "./handlers.js";
import { StateMap } from "./state-map.js";
import { readPhase, disconnectProviders } from "./read-phase.js";
import { planPhase } from "./plan-phase.js";
import {
  executePhase,
  type ResourceOutcome as ExecutorResourceOutcome,
} from "./execute-phase.js";

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
  /** Include ONLY resources matching any of these tags, plus their transitive dependencies */
  readonly tags?: readonly string[];
  /** Exclude resources matching any of these tags, unless depended on by an included resource */
  readonly skipTags?: readonly string[];
  /** Enable orphan detection during the read phase. */
  readonly orphanDetection?: { readonly enabled: boolean };
  /** When true, produce delete actions for detected orphans. Otherwise report as issues. */
  readonly pruneOrphans?: boolean;
  /**
   * Post-apply handlers — side-effect actions triggered by resource changes.
   * Handlers contain functions and can't be serialised, so they are passed
   * separately from the IR.
   */
  readonly handlers?: readonly InfraHandler[];
}

/** Per-resource outcome from a sync run. */
export interface ResourceOutcome {
  readonly name: string;
  readonly action: PlanAction;
  readonly status: "success" | "failed";
  readonly state: unknown;
  readonly diff: readonly FieldDiff[];
}

/** The result of a sync execution. */
export interface SyncResult {
  readonly resources: readonly ResourceOutcome[];
  readonly issues: readonly ResourceIssue[];
  /** Handler outcomes — only populated in apply mode when handlers are registered. */
  readonly handlerOutcomes: readonly HandlerOutcome[];
}

// ─── SyncEngine ──────────────────────────────────────────────────────────────

/**
 * The main sync engine. Consumes a compiled InfraIR and executes the
 * three-phase pipeline: read → plan → execute.
 */
export class SyncEngine {
  constructor(private readonly adapters: Map<string, ProviderAdapter>) {}

  /**
   * Execute the full three-phase pipeline.
   */
  async execute(ir: InfraIR, options?: SyncOptions): Promise<SyncResult> {
    const dryRun = options?.mode === "plan";

    // Phase 1: Read
    const read = await readPhase({
      ir,
      adapters: this.adapters,
      ...(options?.secretResolver !== undefined
        ? { secretResolver: options.secretResolver }
        : {}),
      ...(options?.cache !== undefined ? { cache: options.cache } : {}),
      ...(options?.cacheTtl !== undefined
        ? { cacheTtl: options.cacheTtl }
        : {}),
      ...(options?.orphanDetection !== undefined
        ? { orphanDetection: options.orphanDetection }
        : {}),
    });

    if (read.issues.length > 0) {
      await disconnectProviders(read.instances);
      return { resources: [], issues: read.issues, handlerOutcomes: [] };
    }

    try {
      // Phase 2: Plan
      const plan = planPhase({
        ir,
        stateMap: read.stateMap,
        instances: read.instances,
        configs: read.configs,
        ...(options?.tags !== undefined ? { tags: options.tags } : {}),
        ...(options?.skipTags !== undefined
          ? { skipTags: options.skipTags }
          : {}),
        ...(read.orphans !== undefined ? { orphans: read.orphans } : {}),
        ...(options?.pruneOrphans !== undefined
          ? { pruneOrphans: options.pruneOrphans }
          : {}),
      });

      if (plan.issues.length > 0) {
        return { resources: [], issues: plan.issues, handlerOutcomes: [] };
      }

      // Phase 3: Execute
      const execute = await executePhase({
        actionDag: plan.actionDag,
        instances: read.instances,
        configs: read.configs,
        initialState: read.stateMap.toJSON(),
        dryRun,
      });

      return await buildResult(execute.result, dryRun, options?.handlers);
    } finally {
      await disconnectProviders(read.instances);
    }
  }

  /**
   * Plan only — returns the ActionDag and StateMap without executing.
   */
  async plan(
    ir: InfraIR,
    options?: SyncOptions,
  ): Promise<{
    actionDag: ActionDag;
    stateMap: StateMap;
    issues: readonly ResourceIssue[];
  }> {
    const read = await readPhase({
      ir,
      adapters: this.adapters,
      ...(options?.secretResolver !== undefined
        ? { secretResolver: options.secretResolver }
        : {}),
      ...(options?.cache !== undefined ? { cache: options.cache } : {}),
      ...(options?.cacheTtl !== undefined
        ? { cacheTtl: options.cacheTtl }
        : {}),
      ...(options?.orphanDetection !== undefined
        ? { orphanDetection: options.orphanDetection }
        : {}),
    });

    if (read.issues.length > 0) {
      await disconnectProviders(read.instances);
      const emptyDag: ActionDag = {
        actions: [],
        planTimestamp: new Date().toISOString(),
        infraIRHash: "",
        stateMapHash: "",
      };
      return {
        actionDag: emptyDag,
        stateMap: read.stateMap,
        issues: read.issues,
      };
    }

    try {
      const plan = planPhase({
        ir,
        stateMap: read.stateMap,
        instances: read.instances,
        configs: read.configs,
        ...(options?.tags !== undefined ? { tags: options.tags } : {}),
        ...(options?.skipTags !== undefined
          ? { skipTags: options.skipTags }
          : {}),
        ...(read.orphans !== undefined ? { orphans: read.orphans } : {}),
        ...(options?.pruneOrphans !== undefined
          ? { pruneOrphans: options.pruneOrphans }
          : {}),
      });

      return {
        actionDag: plan.actionDag,
        stateMap: read.stateMap,
        issues: plan.issues,
      };
    } finally {
      await disconnectProviders(read.instances);
    }
  }

  /**
   * Execute a pre-built ActionDag.
   */
  async executeFromPlan(
    actionDag: ActionDag,
    options?: SyncOptions,
  ): Promise<SyncResult> {
    const read = await readPhase({
      ir: reconstructIR(actionDag),
      adapters: this.adapters,
      ...(options?.secretResolver !== undefined
        ? { secretResolver: options.secretResolver }
        : {}),
    });

    if (read.issues.length > 0) {
      await disconnectProviders(read.instances);
      return { resources: [], issues: read.issues, handlerOutcomes: [] };
    }

    try {
      const execute = await executePhase({
        actionDag,
        instances: read.instances,
        configs: read.configs,
        initialState: read.stateMap.toJSON(),
        dryRun: options?.mode === "plan",
      });

      return await buildResult(
        execute.result,
        options?.mode === "plan",
        options?.handlers,
      );
    } finally {
      await disconnectProviders(read.instances);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function buildResult(
  result: {
    resources: readonly ExecutorResourceOutcome[];
    issues: readonly ResourceIssue[];
  },
  dryRun: boolean,
  handlers?: readonly InfraHandler[],
): Promise<SyncResult> {
  const resources: ResourceOutcome[] = result.resources.map((r) => ({
    name: r.name,
    action: r.action,
    status: r.status,
    state: r.state,
    diff: r.diff,
  }));

  // Run post-apply handlers (only in apply mode)
  let handlerOutcomes: readonly HandlerOutcome[] = [];
  if (!dryRun && handlers !== undefined && handlers.length > 0) {
    handlerOutcomes = await executeHandlers(
      handlers,
      resources.map((r) => ({
        name: r.name,
        action: r.action,
        diff: r.diff,
      })),
    );
  }

  return {
    resources,
    issues: result.issues,
    handlerOutcomes,
  };
}

function reconstructIR(actionDag: ActionDag): InfraIR {
  const providers = new Map<
    string,
    { key: string; adapterName: string; config: Record<string, unknown> }
  >();

  for (const action of actionDag.actions) {
    if (!providers.has(action.provider)) {
      providers.set(action.provider, {
        key: action.provider,
        adapterName: action.provider,
        config: {},
      });
    }
  }

  return {
    name: "reconstructed",
    providers: [...providers.values()],
    resources: [],
  };
}
