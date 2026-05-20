/**
 * `infrasync migrate` command — unified migration pipeline.
 *
 * Accepts Terraform input from:
 *   --terraform-file <path>  Pre-built TerraformIR JSON
 *   --file <path>            Alias for --terraform-file
 *   --statefile <path>       Binary Terraform state file (runs terraform show -json)
 *   --planfile <path>        Binary Terraform plan file (runs terraform show -json)
 *
 * Accepts InfraSync input from:
 *   --infrasync-file <path>  Pre-built InfraIR JSON
 *   --config <path>          TypeScript infra config (compiled to InfraIR)
 *   --ir <path>              Alias for --infrasync-file
 *
 * At least one Terraform source and one InfraSync source must be provided.
 */
import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  compare,
  executePlan,
  PluginRegistry,
  cloudflarePlugin,
  genericPlugin,
} from "@infrasync-org/migration-planner";
import { terraformIRSchema } from "@infrasync-org/core-ir/schemas";
import { infraIRSchema } from "@infrasync-org/core/schemas";
import {
  importStateJson,
  importPlanJson,
} from "@infrasync-org/adapter-terraform-show-json/import-show-json";
import { runTerraformShowJson } from "./terraform-show-json.js";
import type {
  MigrationPlan,
  MigrationDirection,
  ExecutionResult,
} from "@infrasync-org/migration-planner";
import type { InfraIR } from "@infrasync-org/core/types";
import type { TerraformIR } from "@infrasync-org/core-ir/schemas";
import type {
  ProviderPort,
  ProviderAdapter,
} from "@infrasync-org/core/provider";

export interface MigrateOptions {
  /** Pre-built TerraformIR JSON file */
  terraformFile: string | undefined;
  /** Terraform state file (binary, runs terraform show -json) */
  statefile: string | undefined;
  /** Terraform plan file (binary, runs terraform show -json) */
  planfile: string | undefined;
  /** Pre-built InfraIR JSON file */
  infrasyncFile: string | undefined;
  /** TypeScript infra config file */
  config: string | undefined;
  /** Pre-built InfraIR JSON file (alias) */
  ir: string | undefined;
  direction: MigrationDirection;
  out: string | undefined;
  json: boolean;
  /** Execute the migration plan (default: plan only) */
  apply: boolean | undefined;
  /** Apply without executing (show what would happen) */
  dryRun: boolean | undefined;
  /** Adapter registry for provider connection (required with --apply) */
  adapters: ReadonlyMap<string, ProviderAdapter> | undefined;
}

export async function runMigrateCommand(
  options: MigrateOptions,
  infraIRLoader: (
    configPath: string,
    irPath: string | undefined,
  ) => Promise<InfraIR>,
): Promise<void> {
  const tfIR = await loadTerraformIR(options);
  const infraIR = await loadInfraIR(options, infraIRLoader);

  // Build plugin registry
  const registry = new PluginRegistry();
  registry.register(genericPlugin);
  registry.register(cloudflarePlugin);

  // Compare
  console.log(`\nComparing (${options.direction})...`);
  const plan = compare(tfIR, infraIR, {
    direction: options.direction,
    registry,
  });

  // Output the plan
  if (options.json) {
    await outputJson(plan, options.out);
  } else {
    outputHumanReadable(plan);
  }

  // Execute if --apply is set
  if (options.apply === true) {
    const connectedProviders = await connectProviders(
      infraIR,
      options.adapters,
    );

    try {
      console.log("\nExecuting migration plan...");
      const execResult = await executePlan(plan, {
        providers: connectedProviders,
        infraIR,
        terraformIR: tfIR,
        dryRun: options.dryRun ?? false,
      });

      outputExecutionResult(execResult);
    } finally {
      await disconnectProviders(connectedProviders);
    }
  }
}

// ─── TerraformIR loading ─────────────────────────────────────────────────────

async function loadTerraformIR(options: MigrateOptions): Promise<TerraformIR> {
  const sources = [
    options.terraformFile,
    options.statefile,
    options.planfile,
  ].filter((s) => s !== undefined && s.length > 0);

  if (sources.length === 0) {
    console.error(
      "Error: no Terraform source provided. Use --terraform-file, --statefile, or --planfile.",
    );
    process.exit(1);
  }

  if (sources.length > 1) {
    console.error(
      "Error: multiple Terraform sources provided. Use only one of --terraform-file, --statefile, or --planfile.",
    );
    process.exit(1);
  }

  // --terraform-file: load pre-built TerraformIR JSON
  if (options.terraformFile !== undefined && options.terraformFile.length > 0) {
    console.log(
      `Loading TerraformIR from ${resolve(options.terraformFile)}...`,
    );
    const raw = await readFile(resolve(options.terraformFile), "utf-8");
    const tfIR = terraformIRSchema.parse(JSON.parse(raw));
    console.log(
      `  ${String(tfIR.resources.length)} resource(s), ${String(tfIR.outputs.length)} output(s)`,
    );
    return tfIR;
  }

  // --statefile: run terraform show -json on a binary state file
  if (options.statefile !== undefined && options.statefile.length > 0) {
    console.log(
      `Running terraform show -json on ${resolve(options.statefile)}...`,
    );
    const raw = runTerraformShowJson(options.statefile);
    const result = importStateJson(raw);
    console.log(
      `  Imported state: ${String(result.document.resources.length)} resource(s), ${String(result.document.outputs.length)} output(s)`,
    );
    return result.document;
  }

  // --planfile: run terraform show -json on a binary plan file
  if (options.planfile !== undefined && options.planfile.length > 0) {
    console.log(
      `Running terraform show -json on ${resolve(options.planfile)}...`,
    );
    const raw = runTerraformShowJson(options.planfile);
    const result = importPlanJson(raw);
    console.log(
      `  Imported plan: ${String(result.document.resources.length)} resource(s), ${String(result.document.outputs.length)} output(s)`,
    );
    return result.document;
  }

  // Unreachable — the validation above ensures one source is present
  throw new Error("No Terraform source provided");
}

// ─── InfraIR loading ──────────────────────────────────────────────────────────

async function loadInfraIR(
  options: MigrateOptions,
  infraIRLoader: (
    configPath: string,
    irPath: string | undefined,
  ) => Promise<InfraIR>,
): Promise<InfraIR> {
  const filePath = options.infrasyncFile ?? options.ir;
  const configPath = options.config;

  if (filePath !== undefined && filePath.length > 0) {
    // Pre-built InfraIR JSON
    console.log(`Loading InfraIR from ${resolve(filePath)}...`);
    const raw = await readFile(resolve(filePath), "utf-8");
    const infraIR = infraIRSchema.parse(JSON.parse(raw));
    console.log(
      `  ${String(infraIR.providers.length)} provider(s), ${String(infraIR.resources.length)} resource(s)`,
    );
    return infraIR;
  }

  if (configPath !== undefined && configPath.length > 0) {
    // Compile from TypeScript config
    console.log(`Compiling InfraIR from ${resolve(configPath)}...`);
    const infraIR = await infraIRLoader(configPath, undefined);
    console.log(
      `  ${String(infraIR.providers.length)} provider(s), ${String(infraIR.resources.length)} resource(s)`,
    );
    return infraIR;
  }

  console.error(
    "Error: no InfraSync source provided. Use --infrasync-file, --ir, or --config.",
  );
  process.exit(1);
}

// ─── Provider connection ────────────────────────────────────────────────────

/**
 * Connect provider adapters from InfraIR.
 *
 * Resolves secrets from environment variables, validates config, and
 * initialises SDK clients for each provider instance.
 */
async function connectProviders(
  infraIR: InfraIR,
  adapterRegistry: ReadonlyMap<string, ProviderAdapter> | undefined,
): Promise<Map<string, ProviderPort>> {
  const instances = new Map<string, ProviderPort>();

  if (adapterRegistry === undefined || adapterRegistry.size === 0) {
    console.log(
      "  No adapters registered — InfraSync-targeted steps will fail. Provide adapters via --adapters or config file.",
    );
    return instances;
  }

  for (const provider of infraIR.providers) {
    const adapter = adapterRegistry.get(provider.adapterName);
    if (adapter === undefined) {
      console.error(
        `  Warning: no adapter registered for "${provider.adapterName}" (provider instance "${provider.key}")`,
      );
      continue;
    }

    const instance = adapter.create();
    const resolvedConfig = resolveConfigSecrets(provider.config);

    const result = instance.configSchema.safeParse(resolvedConfig);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      console.error(
        `  Warning: invalid config for provider "${provider.key}": ${issues}`,
      );
      continue;
    }

    console.log(
      `  Connecting provider "${provider.key}" (${provider.adapterName})...`,
    );
    await instance.connect(resolvedConfig);
    instances.set(provider.key, instance);
  }

  return instances;
}

async function disconnectProviders(
  instances: Map<string, ProviderPort>,
): Promise<void> {
  const results = await Promise.allSettled(
    [...instances.values()].map((instance) => instance.disconnect()),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      console.error("  Failed to disconnect provider:", result.reason);
    }
  }
}

/** Resolve $secret.env references in provider config from process.env. */
function resolveConfigSecrets(
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretSource(value)) {
      resolved[key] = process.env[value.$secret.name] ?? "";
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretSource(
  value: unknown,
): value is { $secret: { kind: string; name: string } } {
  if (!isRecord(value)) return false;
  if (!("$secret" in value)) return false;
  const secret = value.$secret;
  return typeof secret === "object" && secret !== null;
}

// ─── Output ───────────────────────────────────────────────────────────────────

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
  "replace-create": "↑",
  "replace-destroy": "↓",
};

function outputHumanReadable(plan: MigrationPlan): void {
  const { summary, changes, steps, warnings } = plan;

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║        Migration Plan — ${plan.direction}     `);
  console.log(`╚══════════════════════════════════════════╝\n`);

  console.log("Summary:");
  console.log(`  Total resources: ${String(summary.total)}`);
  console.log(
    `  Unchanged: ${String(summary.unchanged)}  |  Safe: ${String(summary.safe)}  |  Risky: ${String(summary.risky)}  |  Destructive: ${String(summary.destructive)}`,
  );
  console.log(
    `  Creates: ${String(summary.creates)}  |  Updates: ${String(summary.updates)}  |  Deletes: ${String(summary.deletes)}`,
  );

  if (changes.length > 0) {
    console.log("\nResource Changes:");
    for (const change of changes) {
      const icon = SAFETY_ICONS[change.safety] ?? "?";
      const action = ACTION_LABELS[change.action] ?? "?";
      const name = change.tfKey?.name ?? change.infraKey?.name ?? "unknown";
      const type = change.tfKey?.type ?? change.infraKey?.type ?? "unknown";

      const mitigationLabel =
        change.mitigation !== undefined
          ? ` [${change.mitigation.strategy}]`
          : "";
      console.log(
        `  ${icon} ${action} ${type} "${name}" [${change.safety}]${mitigationLabel}`,
      );

      if (change.mitigation !== undefined) {
        const autoLabel = change.mitigation.automated ? "auto" : "manual";
        const downtimeLabel = change.mitigation.requiresDowntime
          ? "downtime"
          : "zero-downtime";
        console.log(
          `    ↳ ${autoLabel}, ${change.mitigation.strategy}, ${downtimeLabel}`,
        );
      }

      for (const diff of change.attributeDiffs) {
        const diffIcon = SAFETY_ICONS[diff.safety] ?? "?";
        const mitigationTag =
          diff.mitigation !== undefined ? ` (${diff.mitigation})` : "";
        console.log(
          `    ${diffIcon} ${diff.path}: ${formatValue(diff.before)} → ${formatValue(diff.after)} (${diff.rule})${mitigationTag}`,
        );
      }
    }
  }

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
  outPath: string | undefined,
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

function outputExecutionResult(result: ExecutionResult): void {
  console.log(`\n─── Execution Result ───`);
  console.log(`  Steps: ${String(result.totalSteps)}`);
  console.log(
    `  Succeeded: ${String(result.succeeded)}  |  Failed: ${String(result.failed)}  |  Skipped: ${String(result.skipped)}  |  Pending: ${String(result.pendingConfirmation)}`,
  );
  console.log(`  Duration: ${String(result.durationMs)}ms`);

  if (result.outcomes.length > 0) {
    console.log("\n  Step Outcomes:");
    for (const outcome of result.outcomes) {
      const icon =
        outcome.status === "success"
          ? "✓"
          : outcome.status === "failed"
            ? "✗"
            : outcome.status === "skipped"
              ? "⊘"
              : "⚠";
      const errorTag = outcome.error !== undefined ? ` — ${outcome.error}` : "";
      console.log(
        `    ${icon} [${outcome.stepId}] ${outcome.status} (${String(outcome.durationMs)}ms): ${outcome.message}${errorTag}`,
      );
    }
  }

  console.log();
}
