/**
 * Migration execution engine.
 *
 * Takes a MigrationPlan and executes its steps against the target system
 * (InfraSync or Terraform), respecting dependency ordering and reporting
 * per-step outcomes.
 *
 * InfraSync execution uses the existing ProviderPort/ResourcePort APIs.
 * Terraform execution generates scoped *.tf.json and invokes terraform apply.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MigrationPlan,
  MigrationStep,
  StepOutcome,
  ExecutionResult,
} from "./schemas.js";
import {
  ResolvedScopes,
  type ProviderPort,
  type ResourcePort,
} from "@infrasync/core/provider";
import { exportTfConfigJson } from "@infrasync/adapter-terraform-config-json/export-config-json";
import { cloudflareResourceMappers } from "@infrasync/adapter-terraform-config-json/cloudflare-mappers";
import type { InfraIR, ResourceIR } from "@infrasync/core/types";
import type { TerraformIR } from "@infrasync/core-ir/schemas";

// ─── Public types ────────────────────────────────────────────────────────────

/** Provides the execution context the executor needs. */
export interface ExecutionContext {
  /** Connected InfraSync provider instances (key → ProviderPort) */
  readonly providers: ReadonlyMap<string, ProviderPort>;
  /** The InfraSync IR being migrated towards */
  readonly infraIR: InfraIR;
  /** The Terraform IR being migrated from */
  readonly terraformIR: TerraformIR;
  /** Path to terraform binary. Defaults to "terraform". */
  readonly terraformBin?: string;
  /** Working directory for Terraform operations. Defaults to OS temp dir. */
  readonly workingDir?: string;
  /** Whether to actually apply changes. false = dry run (plan only). */
  readonly dryRun?: boolean;
  /** Called before each step executes. Return false to skip the step. */
  readonly onStep?: (step: MigrationStep) => Promise<boolean>;
}

/** Controls executor behaviour. */
export interface ExecutorOptions {
  /** Maximum parallelism within a dependency level. Default: 8. */
  readonly concurrency?: number;
}

// ─── Executor ────────────────────────────────────────────────────────────────

/**
 * Executes a MigrationPlan by running its steps in dependency order.
 *
 * Usage:
 * ```typescript
 * const result = await executePlan(plan, context);
 * console.log(`${result.succeeded} succeeded, ${result.failed} failed`);
 * ```
 */
export async function executePlan(
  plan: MigrationPlan,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const outcomes: StepOutcome[] = [];

  // Sort steps into dependency levels using Kahn's algorithm
  const levels = computeDependencyLevels(plan.steps);

  // Track which step IDs have failed, so dependents are skipped
  const failedStepIds = new Set<string>();

  for (const level of levels) {
    // Execute all steps in this level concurrently
    const levelOutcomes = await Promise.all(
      level.map((step) => executeStep(step, context, failedStepIds)),
    );

    for (const outcome of levelOutcomes) {
      outcomes.push(outcome);
      if (outcome.status === "failed") {
        failedStepIds.add(outcome.stepId);
      }
    }
  }

  const succeeded = outcomes.filter((o) => o.status === "success").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  const pendingConfirmation = outcomes.filter(
    (o) => o.status === "requires-confirmation",
  ).length;

  return {
    totalSteps: outcomes.length,
    outcomes,
    succeeded,
    failed,
    skipped,
    pendingConfirmation,
    durationMs: Date.now() - startTime,
  };
}

// ─── Dependency level computation ────────────────────────────────────────────

/**
 * Group steps into dependency levels using Kahn's algorithm.
 * Steps in the same level have no dependencies between them and can run in parallel.
 */
function computeDependencyLevels(
  steps: readonly MigrationStep[],
): MigrationStep[][] {
  const stepMap = new Map<string, MigrationStep>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    stepMap.set(step.id, step);
    inDegree.set(step.id, step.dependsOn.length);
    for (const dep of step.dependsOn) {
      const list = dependents.get(dep);
      if (list !== undefined) {
        list.push(step.id);
      } else {
        dependents.set(dep, [step.id]);
      }
    }
  }

  const levels: MigrationStep[][] = [];
  let queue = steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id);

  while (queue.length > 0) {
    const level: MigrationStep[] = [];
    const nextQueue: string[] = [];

    for (const id of queue) {
      const step = stepMap.get(id);
      if (step !== undefined) {
        level.push(step);
      }

      for (const dependentId of dependents.get(id) ?? []) {
        const current = inDegree.get(dependentId) ?? 0;
        if (current > 0) {
          const newDegree = current - 1;
          inDegree.set(dependentId, newDegree);
          if (newDegree === 0) {
            nextQueue.push(dependentId);
          }
        }
      }
    }

    if (level.length > 0) {
      levels.push(level);
    }
    queue = nextQueue;
  }

  return levels;
}

// ─── Step execution ──────────────────────────────────────────────────────────

async function executeStep(
  step: MigrationStep,
  context: ExecutionContext,
  failedStepIds: ReadonlySet<string>,
): Promise<StepOutcome> {
  const startTime = Date.now();

  // Check if any dependency failed → skip
  for (const depId of step.dependsOn) {
    if (failedStepIds.has(depId)) {
      return {
        stepId: step.id,
        status: "skipped",
        message: `Skipped: dependency "${depId}" failed`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // manual-intervention steps always require confirmation
  if (step.action === "manual-intervention") {
    return {
      stepId: step.id,
      status: "requires-confirmation",
      message: step.description,
      durationMs: Date.now() - startTime,
    };
  }

  // Check onStep callback
  if (context.onStep !== undefined) {
    const shouldProceed = await context.onStep(step);
    if (!shouldProceed) {
      return {
        stepId: step.id,
        status: "skipped",
        message: "Skipped by user callback",
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Dry run → skip actual execution
  if (context.dryRun === true) {
    return {
      stepId: step.id,
      status: "success",
      message: `Dry run: ${step.description}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Dispatch to target-specific handler
  try {
    const message =
      step.target === "infrasync"
        ? await executeInfraSyncStep(step, context)
        : await executeTerraformStep(step, context);

    return {
      stepId: step.id,
      status: "success",
      message,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      stepId: step.id,
      status: "failed",
      message: step.description,
      durationMs: Date.now() - startTime,
      error: errorMsg,
    };
  }
}

// ─── InfraSync execution ─────────────────────────────────────────────────────

async function executeInfraSyncStep(
  step: MigrationStep,
  context: ExecutionContext,
): Promise<string> {
  const { providers, infraIR } = context;
  const resource = findInfraResource(step, infraIR);

  switch (step.action) {
    case "create": {
      if (resource === undefined) {
        throw new Error(
          `Cannot create: no InfraIR resource found for "${step.resourceName}"`,
        );
      }
      const handler = resolveInfraHandler(resource, providers);
      await handler.create(resource.spec);
      return `Created ${step.resourceType} "${step.resourceName}" in InfraSync`;
    }

    case "update": {
      if (resource === undefined) {
        throw new Error(
          `Cannot update: no InfraIR resource found for "${step.resourceName}"`,
        );
      }
      const handler = resolveInfraHandler(resource, providers);
      const state = await handler.read(resource.spec);
      if (state === undefined) {
        throw new Error(
          `Cannot update: resource "${step.resourceName}" does not exist in provider`,
        );
      }
      const id = handler.getStateId(state);
      await handler.update(id, resource.spec);
      return `Updated ${step.resourceType} "${step.resourceName}" in InfraSync`;
    }

    case "replace-create": {
      if (resource === undefined) {
        throw new Error(
          `Cannot replace-create: no InfraIR resource found for "${step.resourceName}"`,
        );
      }
      const handler = resolveInfraHandler(resource, providers);
      await handler.create(resource.spec);
      return `Replace-created ${step.resourceType} "${step.resourceName}" in InfraSync (CBD)`;
    }

    case "replace-destroy": {
      // InfraSync is stateless and doesn't delete — this is a no-op with guidance
      return `Replace-destroy for ${step.resourceType} "${step.resourceName}" — InfraSync does not delete resources. Old resource must be manually cleaned up.`;
    }

    case "delete": {
      // InfraSync does not delete resources — stateless by design
      return `Delete for ${step.resourceType} "${step.resourceName}" — InfraSync does not delete resources. Resource must be manually removed.`;
    }

    case "verify": {
      if (resource === undefined) {
        throw new Error(
          `Cannot verify: no InfraIR resource found for "${step.resourceName}"`,
        );
      }
      const handler = resolveInfraHandler(resource, providers);
      const state = await handler.read(resource.spec);
      if (state === undefined) {
        throw new Error(
          `Verification failed: resource "${step.resourceName}" not found`,
        );
      }
      return `Verified ${step.resourceType} "${step.resourceName}" — exists in provider`;
    }

    default:
      throw new Error(`Unsupported InfraSync step action: ${step.action}`);
  }
}

// ─── Terraform execution ─────────────────────────────────────────────────────

async function executeTerraformStep(
  step: MigrationStep,
  context: ExecutionContext,
): Promise<string> {
  const { terraformIR, infraIR } = context;
  const tfBin = context.terraformBin ?? "terraform";

  switch (step.action) {
    case "create":
    case "update":
    case "replace-create": {
      // Generate *.tf.json and apply via Terraform CLI
      const tfResult = exportTfConfigJson(infraIR, {
        resourceMappers: { cloudflare: cloudflareResourceMappers },
      });

      const workDir =
        context.workingDir ??
        join(tmpdir(), `infrasync-tf-${String(Date.now())}`);
      await mkdir(workDir, { recursive: true });

      const tfJsonPath = join(workDir, "main.tf.json");
      await writeFile(tfJsonPath, tfResult.content, "utf-8");

      // Run terraform init + apply
      await runCommand(tfBin, ["init", "-input=false"], workDir);
      await runCommand(
        tfBin,
        ["apply", "-auto-approve", "-input=false"],
        workDir,
      );

      return `Applied ${step.action} for ${step.resourceType} "${step.resourceName}" via Terraform`;
    }

    case "replace-destroy":
    case "delete": {
      throw new Error(
        `Terraform-targeted ${step.action} for "${step.resourceName}" requires manual Terraform state management. ` +
          `Remove the resource from Terraform config and run \`terraform apply\` manually.`,
      );
    }

    case "verify": {
      const tfResource = findTerraformResource(step, terraformIR);
      if (tfResource === undefined) {
        throw new Error(
          `Verification failed: Terraform resource "${step.resourceName}" not found`,
        );
      }
      return `Verified ${step.resourceType} "${step.resourceName}" — exists in Terraform state`;
    }

    default:
      throw new Error(`Unsupported Terraform step action: ${step.action}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findInfraResource(
  step: MigrationStep,
  infraIR: InfraIR,
): ResourceIR | undefined {
  return infraIR.resources.find((r) => {
    if (r.name === step.resourceName) return true;
    if (toSnakeCase(r.name) === step.resourceName) return true;
    return false;
  });
}

function findTerraformResource(
  step: MigrationStep,
  terraformIR: TerraformIR,
): { readonly address: string } | undefined {
  return terraformIR.resources.find(
    (r) =>
      r.address === `${step.resourceType}.${step.resourceName}` ||
      r.addressParts.name === step.resourceName,
  );
}

function resolveInfraHandler(
  resource: ResourceIR,
  providers: ReadonlyMap<string, ProviderPort>,
): ResourcePort {
  const provider = providers.get(resource.provider);
  if (provider === undefined) {
    throw new Error(
      `Provider instance "${resource.provider}" not connected for resource "${resource.name}"`,
    );
  }
  return provider.resourceHandler(resource.kind, ResolvedScopes.empty);
}

function toSnakeCase(input: string): string {
  return input
    .replace(/([A-Z])/g, "_$1")
    .replace(/^_/, "")
    .toLowerCase();
}

/** Run a command and return stdout. Throws on non-zero exit. */
function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (exit ${String(err.code)}):\n${stderr}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}
