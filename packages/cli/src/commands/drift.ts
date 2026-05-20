import type { InfraIR } from "@infrasync-org/core/types";
import type { AdapterRegistry } from "../registry.js";
import { SyncEngine } from "@infrasync-org/core/sync";

/**
 * Execute a drift detection run — read current state and report
 * any resources that would be created or updated.
 *
 * Unlike `plan`, drift is purely informational. It reports what
 * the engine *would* change, without generating a formal plan entry
 * for each resource.
 *
 * @param ir - Compiled InfraIR
 * @param adapters - Registry of available provider adapters
 * @returns Drift report listing divergent resources
 */
export async function drift(
  ir: InfraIR,
  adapters: AdapterRegistry,
): Promise<DriftOutput> {
  const engine = new SyncEngine(adapters);
  // Plan mode reads state and computes actions without applying
  const result = await engine.execute(ir, { mode: "plan" });

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
}
