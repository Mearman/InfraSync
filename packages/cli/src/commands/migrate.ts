/**
 * `infrasync migrate` command — compare TerraformIR and InfraIR documents,
 * producing a classified migration plan with executable steps.
 */
import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  compare,
  PluginRegistry,
  cloudflarePlugin,
  genericPlugin,
} from "@infrasync/migration-planner";
import { terraformIRSchema } from "@infrasync/core-ir/schemas";
import { infraIRSchema } from "@infrasync/core/schemas";
import type {
  MigrationPlan,
  MigrationDirection,
} from "@infrasync/migration-planner";

export interface MigrateOptions {
  terraformFile: string;
  infrasyncFile: string;
  direction: MigrationDirection;
  out: string | undefined;
  json: boolean;
}

export async function runMigrateCommand(
  options: MigrateOptions,
): Promise<void> {
  const { terraformFile, infrasyncFile, direction, out, json } = options;

  // Load and validate TerraformIR
  console.log(`Loading TerraformIR from ${resolve(terraformFile)}...`);
  const tfRaw = await readFile(resolve(terraformFile), "utf-8");
  const tfIR = terraformIRSchema.parse(JSON.parse(tfRaw));

  console.log(
    `  ${String(tfIR.resources.length)} resource(s), ${String(tfIR.outputs.length)} output(s)`,
  );

  // Load and validate InfraIR
  console.log(`Loading InfraIR from ${resolve(infrasyncFile)}...`);
  const infraRaw = await readFile(resolve(infrasyncFile), "utf-8");
  const infraIR = infraIRSchema.parse(JSON.parse(infraRaw));

  console.log(
    `  ${String(infraIR.providers.length)} provider(s), ${String(infraIR.resources.length)} resource(s)`,
  );

  // Build plugin registry
  const registry = new PluginRegistry();
  registry.register(genericPlugin);
  registry.register(cloudflarePlugin);

  // Compare
  console.log(`\nComparing (${direction})...`);
  const plan = compare(tfIR, infraIR, { direction, registry });

  // Output
  if (json) {
    await outputJson(plan, out);
  } else {
    outputHumanReadable(plan);
  }
}

const SAFETY_ICONS: Record<string, string> = {
  safe: "✓",
  risky: "~",
  destructive: "✗",
};

const ACTION_LABELS: Record<string, string> = {
  create: "+",
  update: "~",
  delete: "-",
  unchanged: "=",
  unresolvable: "?",
};

function outputHumanReadable(plan: MigrationPlan): void {
  const { summary, changes, steps, warnings } = plan;

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║        Migration Plan — ${plan.direction}     `);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // Summary
  console.log("Summary:");
  console.log(`  Total resources: ${String(summary.total)}`);
  console.log(
    `  Unchanged: ${String(summary.unchanged)}  |  Safe: ${String(summary.safe)}  |  Risky: ${String(summary.risky)}  |  Destructive: ${String(summary.destructive)}`,
  );
  console.log(
    `  Creates: ${String(summary.creates)}  |  Updates: ${String(summary.updates)}  |  Deletes: ${String(summary.deletes)}`,
  );

  // Resource changes
  if (changes.length > 0) {
    console.log("\nResource Changes:");
    for (const change of changes) {
      const icon = SAFETY_ICONS[change.safety] ?? "?";
      const action = ACTION_LABELS[change.action] ?? "?";
      const name = change.tfKey?.name ?? change.infraKey?.name ?? "unknown";
      const type = change.tfKey?.type ?? change.infraKey?.type ?? "unknown";
      console.log(`  ${icon} ${action} ${type} "${name}" [${change.safety}]`);

      for (const diff of change.attributeDiffs) {
        const diffIcon = SAFETY_ICONS[diff.safety] ?? "?";
        console.log(
          `    ${diffIcon} ${diff.path}: ${formatValue(diff.before)} → ${formatValue(diff.after)} (${diff.rule})`,
        );
      }
    }
  }

  // Steps
  if (steps.length > 0) {
    console.log("\nMigration Steps:");
    for (const step of steps) {
      const icon = step.requiresConfirmation ? "⚠" : " ";
      console.log(
        `  ${icon} [${step.id}] ${step.action} → ${step.target}: ${step.description}`,
      );
      if (step.dependsOn.length > 0) {
        console.log(`      depends on: ${step.dependsOn.join(", ")}`);
      }
    }
  }

  // Warnings
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of warnings) {
      console.log(`  ⚠ ${warning}`);
    }
  }

  console.log();
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(absent)";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

async function outputJson(
  plan: MigrationPlan,
  outPath?: string,
): Promise<void> {
  const json = JSON.stringify(plan, null, 2);

  if (outPath !== undefined && outPath.length > 0) {
    const resolved = resolve(outPath);
    const dir = resolved.substring(0, resolved.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(resolved, json, "utf-8");
    console.log(`Migration plan written to ${resolved}`);
  } else {
    console.log(json);
  }
}
