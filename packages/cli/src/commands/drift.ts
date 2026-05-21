import type { InfraIR } from "@infrasync-org/core/types";
import type { OrphanedResource } from "@infrasync-org/core/provider";
import type { AdapterRegistry } from "../registry.js";
import { SyncEngine } from "@infrasync-org/core/sync";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DriftOptions {
  /** Enable orphan detection during the read phase. */
  readonly showOrphans?: boolean;
  /** Produce delete actions for detected orphans. */
  readonly prune?: boolean;
}

// ─── Drift command ────────────────────────────────────────────────────────────

/**
 * Execute a drift detection run — read current state and report
 * any resources that would be created or updated.
 *
 * Unlike `plan`, drift is purely informational. It reports what
 * the engine *would* change, without generating a formal plan entry
 * for each resource.
 *
 * When showOrphans is enabled, also detects orphaned resources
 * (resources in the provider not present in the IR).
 * When prune is enabled, adds delete actions for detected orphans.
 *
 * @param ir - Compiled InfraIR
 * @param adapters - Registry of available provider adapters
 * @param options - Drift detection options
 * @returns Drift report listing divergent resources
 */
export async function drift(
  ir: InfraIR,
  adapters: AdapterRegistry,
  options?: DriftOptions,
): Promise<DriftOutput> {
  const engine = new SyncEngine(adapters);
  // Plan mode reads state and computes actions without applying
  const result = await engine.execute(ir, {
    mode: "plan",
    ...(options?.showOrphans === true
      ? { orphanDetection: { enabled: true } }
      : {}),
    ...(options?.prune === true ? { pruneOrphans: true } : {}),
  });

  const drifted = result.resources.filter(
    (r) => r.action !== "no-op" && r.action !== "read",
  );

  return {
    name: ir.name,
    totalResources: result.resources.length,
    driftedResources: drifted,
    issues: result.issues,
    hasDrift: drifted.length > 0,
  };
}

/** Output of a drift command. */
export interface DriftOutput {
  readonly name: string;
  /** Total number of resources in the configuration */
  readonly totalResources: number;
  /** Resources that have drifted from the desired configuration */
  readonly driftedResources: readonly {
    readonly name: string;
    readonly action: string;
    readonly status: string;
  }[];
  /** Validation issues encountered during the drift check */
  readonly issues: readonly {
    readonly resource: string;
    readonly message: string;
  }[];
  /** Whether any drift was detected */
  readonly hasDrift: boolean;
  /** Orphaned resources detected (when --show-orphans is enabled) */
  readonly orphans?: readonly OrphanedResource[];
}
