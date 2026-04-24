import type { InfraIR } from "../../ir/types.js";
import type { AdapterRegistry } from "../registry.js";
import { SyncEngine } from "../../core/sync.js";

/**
 * Execute an apply run — read current state, plan changes, and apply them.
 *
 * @param ir - Compiled InfraIR
 * @param adapters - Registry of available provider adapters
 * @returns Sync result with applied changes
 */
export async function apply(
  ir: InfraIR,
  adapters: AdapterRegistry,
): Promise<ApplyOutput> {
  const engine = new SyncEngine(adapters);
  const result = await engine.execute(ir, { mode: "apply" });
  return {
    name: ir.name,
    resources: result.resources,
    issues: result.issues,
  };
}

/** Output of an apply command. */
export interface ApplyOutput {
  readonly name: string;
  readonly resources: readonly {
    readonly name: string;
    readonly action: string;
    readonly status: string;
  }[];
  readonly issues: readonly {
    readonly resource: string;
    readonly message: string;
  }[];
}
