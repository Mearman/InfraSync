import type { InfraIR } from "@infrasync/core/types";
import type { AdapterRegistry } from "../registry.js";
import { SyncEngine } from "@infrasync/core/sync";

/**
 * Execute a plan run — read current state and compute changes without applying.
 *
 * @param ir - Compiled InfraIR
 * @param adapters - Registry of available provider adapters
 * @returns Sync result with planned actions (no modifications made)
 */
export async function plan(
  ir: InfraIR,
  adapters: AdapterRegistry,
): Promise<PlanOutput> {
  const engine = new SyncEngine(adapters);
  const result = await engine.execute(ir, { mode: "plan" });
  return {
    name: ir.name,
    resources: result.resources,
    issues: result.issues,
  };
}

/** Output of a plan command. */
export interface PlanOutput {
  readonly name: string;
  readonly resources: readonly {
    readonly name: string;
    readonly action: string;
    readonly status: string;
    readonly state: unknown;
  }[];
  readonly issues: readonly {
    readonly resource: string;
    readonly message: string;
  }[];
}
