import { readFileSync, writeFileSync } from "node:fs";
import type { InfraIR } from "@infrasync-org/core/types";
import type { ActionDag } from "@infrasync-org/core/action-dag";
import type { AdapterRegistry } from "../registry.js";
import { SyncEngine } from "@infrasync-org/core/sync";
import {
  renderPlanText,
  renderPlanDot,
  serialisePlan,
  parsePlan,
} from "../renderers/plan-renderer.js";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface PlanOptions {
  /** Save the serialised plan to this file path */
  savePlan?: string;
  /** Render the plan as a DOT graph */
  showGraph?: boolean;
}

export interface ApplyFromPlanOptions {
  /** Path to a saved plan JSON file */
  fromPlan?: string;
}

// ─── Plan command ────────────────────────────────────────────────────────────

/**
 * Execute a plan run — read current state and compute changes without applying.
 *
 * @param ir - Compiled InfraIR
 * @param adapters - Registry of available provider adapters
 * @param options - Plan rendering options
 * @returns Plan output with rendered text, the ActionDag, and any issues
 */
export async function plan(
  ir: InfraIR,
  adapters: AdapterRegistry,
  options?: PlanOptions,
): Promise<PlanOutput> {
  const engine = new SyncEngine(adapters);
  const planResult = await engine.plan(ir);

  // Render output
  const text = renderPlanText(planResult.actionDag);

  if (options?.showGraph === true) {
    const dot = renderPlanDot(planResult.actionDag);
    console.log(dot);
  } else {
    console.log(text);
  }

  // Save plan if requested
  if (options?.savePlan !== undefined) {
    const json = serialisePlan(planResult.actionDag);
    writeFileSync(options.savePlan, json, "utf-8");
    console.log(`Plan saved to ${options.savePlan}`);
  }

  return {
    name: ir.name,
    actionDag: planResult.actionDag,
    resources: planResult.actionDag.actions.map((a) => ({
      name: a.resource,
      action: a.action,
      status: "planned",
      state: undefined,
    })),
    issues: planResult.issues,
  };
}

// ─── Apply from plan ─────────────────────────────────────────────────────────

/**
 * Execute a previously saved plan from a JSON file.
 *
 * @param planPath - Path to the saved plan JSON file
 * @param adapters - Registry of available provider adapters
 * @returns Sync result from executing the plan
 */
export async function applyFromPlan(
  planPath: string,
  adapters: AdapterRegistry,
): Promise<PlanOutput> {
  const json = readFileSync(planPath, "utf-8");
  const actionDag = parsePlan(json);

  const engine = new SyncEngine(adapters);
  const result = await engine.executeFromPlan(actionDag);

  const text = renderPlanText(actionDag);
  console.log(text);

  return {
    name: "from-plan",
    actionDag,
    resources: result.resources.map((r) => ({
      name: r.name,
      action: r.action,
      status: r.status,
      state: r.state,
    })),
    issues: result.issues,
  };
}

// ─── Output types ────────────────────────────────────────────────────────────

/** Output of a plan command. */
export interface PlanOutput {
  readonly name: string;
  readonly actionDag: ActionDag;
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
