import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig } from "./loader.js";
import { loadAdapters, loadIR } from "./ir-loader.js";
import { buildRegistry } from "./registry.js";
import { plan } from "./commands/plan.js";
import { apply } from "./commands/apply.js";
import { drift } from "./commands/drift.js";
import { exportCdktfTypeScript } from "./commands/export-cdktf-ts.js";
import { runFidelityCommand } from "./commands/fidelity.js";
import { runMigrateCommand } from "./commands/migrate.js";
import { runTerraformShowJson } from "./commands/terraform-show-json.js";
import type { InfraIR } from "@infrasync/core/types";
import { importTfConfigJson } from "@infrasync/adapter-terraform-config-json/import-config-json";
import { exportTfConfigJson } from "@infrasync/adapter-terraform-config-json/export-config-json";
import { cloudflareResourceMappers } from "@infrasync/adapter-terraform-config-json/cloudflare-mappers";
import {
  importStateJson,
  importPlanJson,
} from "@infrasync/adapter-terraform-show-json/import-show-json";
import { convertToInfraIR } from "@infrasync/adapter-terraform-show-json/convert-to-infra-ir";
import { terraformIRSchema } from "@infrasync/core-ir/schemas";
import type { MigrationDirection } from "@infrasync/migration-planner";

// ─── Built-in adapters ───────────────────────────────────────────────────────

/**
 * No adapters are built-in to the CLI. Users must supply adapters via
 * the config file's `adapters` export. This keeps the CLI package thin
 * and means adding a provider never requires a CLI release.
 */
const builtinAdapters = buildRegistry({});

type RuntimeCommand = "apply" | "plan" | "drift";

// ─── Argument parsing ────────────────────────────────────────────────────────

const args = parseArgs({
  allowPositionals: true,
  options: {
    config: {
      type: "string",
      short: "c",
      description: "Path to the infra config file",
    },
    ir: {
      type: "string",
      description: "Path to a serialised InfraIR JSON file",
    },
    adapters: {
      type: "string",
      description:
        "Path to a module exporting provider adapters (used with --ir for apply/plan/drift)",
    },
    out: {
      type: "string",
      description: "Output directory for export commands",
    },
    stack: {
      type: "string",
      description: "Stack name override for export commands",
    },
    "provider-source": {
      type: "string",
      multiple: true,
      description:
        "Override Terraform provider source mapping (format: adapter=registry/source)",
    },
    file: {
      type: "string",
      description: "Input file path for import/fidelity commands",
    },
    planfile: {
      type: "string",
      description:
        "Path to a binary Terraform plan file (runs terraform show -json automatically)",
    },
    statefile: {
      type: "string",
      description:
        "Path to a Terraform state file (runs terraform show -json automatically)",
    },
    json: {
      type: "boolean",
      description: "Output as JSON (for fidelity command)",
    },
    "convert-infra": {
      type: "boolean",
      description:
        "Convert TerraformIR to InfraIR after import (terraform-state/terraform-plan)",
    },
    "terraform-file": {
      type: "string",
      description: "Path to TerraformIR JSON file (for migrate command)",
    },
    "infrasync-file": {
      type: "string",
      description: "Path to InfraIR JSON file (for migrate command)",
    },
    direction: {
      type: "string",
      description: "Migration direction: tf-to-infrasync or infrasync-to-tf",
    },
    apply: {
      type: "boolean",
      description: "Execute the migration plan after generating it",
    },
    "dry-run": {
      type: "boolean",
      description:
        "Show what would happen without making changes (use with --apply)",
    },
    help: {
      type: "boolean",
      short: "h",
      description: "Show help",
    },
  },
});

// ─── Help ────────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`InfraSync — stateless infrastructure management

Usage:
  infrasync <command> [options]

Commands:
  apply               Apply configuration from a config file
  plan                Preview changes without applying
  drift               Show drift between desired and actual state
  fidelity            Display a fidelity report from an adapter result
  import terraform-config  Import a *.tf.json file into InfraIR
  import terraform-plan    Import terraform show -json plan output into Terraform IR
  import terraform-state   Import terraform show -json state output into Terraform IR
  export cdktf-ts           Generate a CDKTF TypeScript project from InfraIR
  export terraform-config   Export InfraIR as Terraform Configuration JSON (*.tf.json)
  migrate                   Compare TerraformIR and InfraIR, produce migration plan

Options:
  -c, --config <path>                      Path to infra config file (default: infra.config.ts)
      --ir <path>                          Path to serialised InfraIR JSON file
      --adapters <path>                    Path to adapters module (required with --ir for apply/plan/drift)
      --out <path>                         Output directory for export commands
      --file <path>                        Input file path for import/fidelity commands
      --planfile <path>                    Path to binary Terraform plan file (runs terraform show -json)
      --statefile <path>                   Path to Terraform state file (runs terraform show -json)
      --stack <name>                       Stack name override for export commands
      --provider-source <adapter=source>   Override Terraform provider source mapping
      --json                               Output fidelity report as JSON
      --convert-infra                      Convert TerraformIR → InfraIR after import
      --terraform-file <path>              TerraformIR file for migrate command
      --infrasync-file <path>              InfraIR file for migrate command
      --direction <dir>                    Migration direction (tf-to-infrasync|infrasync-to-tf)
  -h, --help                               Show this help message

Examples:
  infrasync apply --config infra.config.ts
  infrasync plan
  infrasync drift
  infrasync apply --ir infra.ir.json --adapters ./adapters.ts
  infrasync fidelity --file adapter-result.json
  infrasync import terraform-config --file main.tf.json --out infra.ir.json
  infrasync import terraform-state --file state.json
  infrasync import terraform-state --statefile terraform.tfstate
  infrasync import terraform-plan --file plan.json
  infrasync migrate --terraform-file tf.json --infrasync-file infra.json --direction tf-to-infrasync
  infrasync migrate --statefile terraform.tfstate --config infra.config.ts --direction tf-to-infrasync
  infrasync migrate --planfile tfplan --ir infra.ir.json --direction infrasync-to-tf --json --out plan.json
  infrasync import terraform-plan --planfile tfplan
  infrasync export terraform-config --config infra.config.ts --out generated.tf.json
  infrasync export cdktf-ts --config infra.config.ts --out ./generated/cdktf
  infrasync export cdktf-ts --ir infra.ir.json --out ./generated/cdktf --provider-source cloudflare=cloudflare/cloudflare
`);
}

if (args.values.help || args.positionals[0] === "--help") {
  showHelp();
  process.exit(0);
}

// ─── Command routing ─────────────────────────────────────────────────────────

const command = args.positionals[0];

if (command === undefined) {
  console.error(
    "Error: no command specified. Use 'plan', 'apply', 'drift', 'fidelity', 'import', or 'export'.",
  );
  console.error("Run 'infrasync --help' for usage.");
  process.exit(1);
}

if (command === "export") {
  runExportCommand().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${message}`);
    process.exit(1);
  });
} else if (command === "import") {
  runImportCommand().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${message}`);
    process.exit(1);
  });
} else if (command === "fidelity") {
  runFidelityCommand(args.values.file ?? "", {
    json: args.values.json,
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${message}`);
    process.exit(1);
  });
} else if (command === "migrate") {
  runMigrateCommand(
    {
      terraformFile: args.values["terraform-file"] ?? undefined,
      statefile: args.values.statefile ?? undefined,
      planfile: args.values.planfile ?? undefined,
      infrasyncFile: args.values["infrasync-file"] ?? undefined,
      config: args.values.config ?? undefined,
      ir: args.values.ir ?? undefined,
      direction: validateDirection(args.values.direction),
      out: args.values.out,
      json: args.values.json ?? false,
      apply: args.values.apply ?? false,
      dryRun: args.values["dry-run"] ?? false,
    },
    loadInfraIrForExport,
  ).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${message}`);
    process.exit(1);
  });
} else {
  runRuntimeCommand(command).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${message}`);
    process.exit(1);
  });
}

async function runExportCommand(): Promise<void> {
  const target = args.positionals[1];
  if (target === "cdktf-ts") {
    await runExportCdktfCommand();
  } else if (target === "terraform-config") {
    await runExportTfConfigCommand();
  } else {
    console.error(
      `Error: unknown export target "${target ?? "(missing)"}". Supported targets: cdktf-ts, terraform-config.`,
    );
    process.exit(1);
  }
}

async function runExportCdktfCommand(): Promise<void> {
  const outDir = args.values.out;
  if (outDir === undefined) {
    console.error("Error: --out is required for export commands.");
    process.exit(1);
  }

  const ir = await loadInfraIrForExport();

  const providerSourceOverrides = parseProviderSourceOverrides(
    args.values["provider-source"],
  );

  console.log(`Exporting CDKTF TypeScript project to ${resolve(outDir)}...`);

  const exportOptions: {
    outDir: string;
    stackName?: string;
    providerSources?: Record<string, string>;
  } = {
    outDir,
  };

  if (args.values.stack !== undefined) {
    exportOptions.stackName = args.values.stack;
  }

  if (Object.keys(providerSourceOverrides).length > 0) {
    exportOptions.providerSources = providerSourceOverrides;
  }

  const result = await exportCdktfTypeScript(ir, exportOptions);

  console.log(`Wrote ${String(result.files.length)} file(s):`);
  for (const file of result.files) {
    console.log(`  • ${file}`);
  }

  if (result.warnings.length > 0) {
    console.log(`\nWarnings (${String(result.warnings.length)}):`);
    for (const warning of result.warnings) {
      console.log(`  ⚠ [${warning.code}] ${warning.message}`);
    }
  }
}

async function runExportTfConfigCommand(): Promise<void> {
  const outPath = args.values.out;
  if (outPath === undefined) {
    console.error("Error: --out is required for export terraform-config.");
    process.exit(1);
  }

  const ir = await loadInfraIrForExport();

  const providerSourceOverrides = parseProviderSourceOverrides(
    args.values["provider-source"],
  );

  console.log(
    `Exporting Terraform Configuration JSON to ${resolve(outPath)}...`,
  );

  const exportOptions: {
    providerSources?: Record<string, string>;
    resourceMappers?: Record<
      string,
      import("@infrasync/adapter-terraform-config-json/export-config-json").ResourceMapper[]
    >;
  } = {};

  if (Object.keys(providerSourceOverrides).length > 0) {
    exportOptions.providerSources = providerSourceOverrides;
  }

  // Always include built-in Cloudflare mappers
  exportOptions.resourceMappers = {
    cloudflare: [...cloudflareResourceMappers],
  };

  const result = exportTfConfigJson(ir, exportOptions);

  const { writeFile } = await import("node:fs/promises");
  const { resolve: pathResolve } = await import("node:path");
  await writeFile(pathResolve(outPath), result.content, "utf-8");

  console.log(`Wrote ${resolve(outPath)}`);

  if (result.warnings.length > 0) {
    console.log(`\nWarnings (${String(result.warnings.length)}):`);
    for (const warning of result.warnings) {
      console.log(`  ⚠ ${warning}`);
    }
  }

  printFidelityReport(result.fidelity);
}

async function runImportCommand(): Promise<void> {
  const target = args.positionals[1];
  if (
    target !== "terraform-config" &&
    target !== "terraform-plan" &&
    target !== "terraform-state"
  ) {
    console.error(
      `Error: unknown import target "${target ?? "(missing)"}". Supported targets: terraform-config, terraform-plan, terraform-state.`,
    );
    process.exit(1);
  }

  const filePath = args.values.file;
  const planfilePath = args.values.planfile;
  const statefilePath = args.values.statefile;

  if (target === "terraform-config") {
    if (filePath === undefined) {
      console.error("Error: --file is required for import terraform-config.");
      process.exit(1);
    }
    await runImportTerraformConfig(filePath);
  } else if (target === "terraform-plan") {
    if (planfilePath !== undefined) {
      await runImportTerraformPlanBinary(planfilePath);
    } else if (filePath !== undefined) {
      await runImportTerraformPlan(filePath);
    } else {
      console.error(
        "Error: --file or --planfile is required for import terraform-plan.",
      );
      process.exit(1);
    }
  } else {
    if (statefilePath !== undefined) {
      await runImportTerraformStateBinary(statefilePath);
    } else if (filePath !== undefined) {
      await runImportTerraformState(filePath);
    } else {
      console.error(
        "Error: --file or --statefile is required for import terraform-state.",
      );
      process.exit(1);
    }
  }
}

async function runImportTerraformConfig(filePath: string): Promise<void> {
  console.log(
    `Importing Terraform Configuration JSON from ${resolve(filePath)}...`,
  );

  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(resolve(filePath), "utf-8");

  const result = importTfConfigJson(raw);

  console.log(
    `Imported "${result.ir.name}" with ${String(result.ir.resources.length)} resource(s) and ${String(result.ir.providers.length)} provider(s)`,
  );

  await writeImportOutput(result.ir, result.warnings, result.fidelity);
}

async function runImportTerraformPlan(filePath: string): Promise<void> {
  console.log(`Importing Terraform plan JSON from ${resolve(filePath)}...`);

  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(resolve(filePath), "utf-8");

  const result = importPlanJson(raw);

  const resourceCount = String(result.document.resources.length);
  const outputCount = String(result.document.outputs.length);
  console.log(
    `Imported Terraform plan with ${resourceCount} resource(s) and ${outputCount} output(s)`,
  );

  await writeImportOutput(
    maybeConvertInfraIR(result.document, args.values["convert-infra"] ?? false),
    result.warnings,
    result.fidelity,
  );
}

async function runImportTerraformPlanBinary(
  planfilePath: string,
): Promise<void> {
  console.log(`Running terraform show -json on ${resolve(planfilePath)}...`);

  const raw = runTerraformShowJson(planfilePath);

  const result = importPlanJson(raw);

  const resourceCount = String(result.document.resources.length);
  const outputCount = String(result.document.outputs.length);
  console.log(
    `Imported Terraform plan with ${resourceCount} resource(s) and ${outputCount} output(s)`,
  );

  await writeImportOutput(
    maybeConvertInfraIR(result.document, args.values["convert-infra"] ?? false),
    result.warnings,
    result.fidelity,
  );
}

async function runImportTerraformState(filePath: string): Promise<void> {
  console.log(`Importing Terraform state JSON from ${resolve(filePath)}...`);

  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(resolve(filePath), "utf-8");

  const result = importStateJson(raw);

  const resourceCount = String(result.document.resources.length);
  const outputCount = String(result.document.outputs.length);
  console.log(
    `Imported Terraform state with ${resourceCount} resource(s) and ${outputCount} output(s)`,
  );

  await writeImportOutput(
    maybeConvertInfraIR(result.document, args.values["convert-infra"] ?? false),
    result.warnings,
    result.fidelity,
  );
}

async function runImportTerraformStateBinary(
  statefilePath: string,
): Promise<void> {
  console.log(`Running terraform show -json on ${resolve(statefilePath)}...`);

  const raw = runTerraformShowJson(statefilePath);

  const result = importStateJson(raw);

  const resourceCount = String(result.document.resources.length);
  const outputCount = String(result.document.outputs.length);
  console.log(
    `Imported Terraform state with ${resourceCount} resource(s) and ${outputCount} output(s)`,
  );

  await writeImportOutput(
    maybeConvertInfraIR(result.document, args.values["convert-infra"] ?? false),
    result.warnings,
    result.fidelity,
  );
}

function validateDirection(value: string | undefined): MigrationDirection {
  if (value === "tf-to-infrasync" || value === "infrasync-to-tf") return value;
  if (value === undefined) {
    console.error(
      "Error: --direction is required (tf-to-infrasync or infrasync-to-tf)",
    );
  } else {
    console.error(
      `Error: invalid direction "${value}". Use tf-to-infrasync or infrasync-to-tf.`,
    );
  }
  process.exit(1);
}

function maybeConvertInfraIR(
  tfDocument: unknown,
  convertInfra: boolean,
): unknown {
  if (!convertInfra) return tfDocument;

  const terraIR = terraformIRSchema.parse(tfDocument);
  const result = convertToInfraIR(terraIR, { name: "converted" });

  console.log(
    `Converted to InfraIR: ${String(result.document.providers.length)} provider(s), ${String(result.document.resources.length)} resource(s)`,
  );
  return result.document;
}

async function writeImportOutput(
  document: unknown,
  warnings: readonly string[],
  fidelity: {
    readonly issues: readonly {
      readonly path: string;
      readonly class: string;
      readonly message: string;
      readonly action: string;
    }[];
  },
): Promise<void> {
  const outPath = args.values.out;
  if (outPath !== undefined) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      resolve(outPath),
      JSON.stringify(document, null, 2) + "\n",
      "utf-8",
    );
    console.log(`Wrote IR to ${resolve(outPath)}`);
  } else {
    console.log("\nIR (JSON):\n");
    console.log(JSON.stringify(document, null, 2));
  }

  if (warnings.length > 0) {
    console.log(`\nWarnings (${String(warnings.length)}):`);
    for (const warning of warnings) {
      console.log(`  ⚠ ${warning}`);
    }
  }

  printFidelityReport(fidelity);
}

function printFidelityReport(fidelity: {
  readonly issues: readonly {
    readonly path: string;
    readonly class: string;
    readonly message: string;
    readonly action: string;
  }[];
}): void {
  if (fidelity.issues.length === 0) return;

  console.log(
    `\nFidelity Report (${String(fidelity.issues.length)} issue(s)):`,
  );
  for (const issue of fidelity.issues) {
    const icon =
      issue.class === "lossless" ? "✓" : issue.class === "lossy" ? "~" : "✗";
    console.log(
      `  ${icon} [${issue.class}] ${issue.path}: ${issue.message} (${issue.action})`,
    );
  }
}

async function loadInfraIrForExport(
  configOverride?: string,
  irOverride?: string,
): Promise<InfraIR> {
  const irPath = irOverride ?? args.values.ir;
  if (irPath !== undefined) {
    console.log(`Loading IR from ${irPath}...`);
    return loadIR(irPath);
  }

  const configPath = resolve(
    configOverride ?? args.values.config ?? "infra.config.ts",
  );
  console.log(`Loading config from ${configPath}...`);
  const config = await loadConfig(configPath);
  const ir = config.infraResult.toIR();

  console.log(
    `Compiled "${ir.name}" with ${String(ir.resources.length)} resource(s) and ${String(ir.providers.length)} provider instance(s)\n`,
  );

  return ir;
}

function parseProviderSourceOverrides(
  rawValues: string | readonly string[] | undefined,
): Record<string, string> {
  const values =
    rawValues === undefined
      ? []
      : typeof rawValues === "string"
        ? [rawValues]
        : [...rawValues];

  const overrides: Record<string, string> = {};

  for (const entry of values) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(
        `Invalid --provider-source value "${entry}". Expected format: adapter=registry/source`,
      );
    }

    const adapter = entry.slice(0, separatorIndex).trim();
    const source = entry.slice(separatorIndex + 1).trim();

    if (adapter.length === 0) {
      throw new Error(
        `Invalid --provider-source value "${entry}": adapter name is empty`,
      );
    }

    if (source.length === 0) {
      throw new Error(
        `Invalid --provider-source value "${entry}": provider source is empty`,
      );
    }

    overrides[adapter] = source;
  }

  return overrides;
}

async function runRuntimeCommand(rawCommand: string): Promise<void> {
  if (
    rawCommand !== "apply" &&
    rawCommand !== "plan" &&
    rawCommand !== "drift"
  ) {
    console.error(
      `Error: unknown command "${rawCommand}". Use 'plan', 'apply', 'drift', or 'export cdktf-ts'.`,
    );
    process.exit(1);
  }

  const command: RuntimeCommand = rawCommand;

  if (args.values.ir !== undefined) {
    if (args.values.adapters === undefined) {
      console.error(
        "Error: --adapters is required when using --ir with apply/plan/drift.",
      );
      console.error("Run 'infrasync --help' for usage.");
      process.exit(1);
    }

    await runWithIR(command, args.values.ir, args.values.adapters);
    return;
  }

  const configPath = resolve(args.values.config ?? "infra.config.ts");
  await run(command, configPath);
}

// ─── IR file execution ───────────────────────────────────────────────────────

/**
 * Execute a command using a raw InfraIR JSON file.
 *
 * Bypasses config file loading and compilation — the IR is already
 * in its final form. Useful for CI pipelines, testing, or external
 * tooling that generates IR.
 */
async function runWithIR(
  command: RuntimeCommand,
  irPath: string,
  adaptersPath: string,
): Promise<void> {
  console.log(`Loading IR from ${irPath}...`);
  const ir = await loadIR(irPath);

  console.log(`Loading adapters from ${adaptersPath}...`);
  const adapterRecord = await loadAdapters(adaptersPath);
  const adapters = new Map(builtinAdapters);
  for (const [name, adapter] of Object.entries(adapterRecord)) {
    adapters.set(name, adapter);
  }

  const resourceCount = String(ir.resources.length);
  const providerCount = String(ir.providers.length);
  console.log(
    `Loaded "${ir.name}" with ${resourceCount} resource(s) and ${providerCount} provider instance(s)\n`,
  );

  switch (command) {
    case "plan": {
      const result = await plan(ir, adapters);
      printPlan(result);
      break;
    }
    case "apply": {
      const result = await apply(ir, adapters);
      printApply(result);
      break;
    }
    case "drift": {
      const result = await drift(ir, adapters);
      printDrift(result);
      break;
    }
  }
}

// ─── Config file execution ────────────────────────────────────────────────────

async function run(command: RuntimeCommand, configPath: string): Promise<void> {
  console.log(`Loading config from ${configPath}...`);
  const config = await loadConfig(configPath);

  // Merge built-in adapters with any custom adapters from the config
  const adapters = new Map(builtinAdapters);
  if (config.adapters !== undefined) {
    for (const [name, adapter] of Object.entries(config.adapters)) {
      adapters.set(name, adapter);
    }
  }

  // Compile to IR
  const ir = config.infraResult.toIR();
  const resourceCount = String(ir.resources.length);
  const providerCount = String(ir.providers.length);
  console.log(
    `Compiled "${ir.name}" with ${resourceCount} resource(s) and ${providerCount} provider instance(s)\n`,
  );

  // Execute
  switch (command) {
    case "plan": {
      const result = await plan(ir, adapters);
      printPlan(result);
      break;
    }
    case "apply": {
      const result = await apply(ir, adapters);
      printApply(result);
      break;
    }
    case "drift": {
      const result = await drift(ir, adapters);
      printDrift(result);
      break;
    }
  }
}

// ─── Output formatting ───────────────────────────────────────────────────────

function printPlan(result: {
  readonly resources: readonly {
    readonly name: string;
    readonly action: string;
    readonly status: string;
  }[];
  readonly issues: readonly {
    readonly resource: string;
    readonly message: string;
  }[];
}): void {
  console.log("Plan results:");
  console.log("─────────────");

  if (result.resources.length === 0) {
    console.log("  (no resources)");
  }

  for (const resource of result.resources) {
    const icon = resource.status === "success" ? "✓" : "✗";
    console.log(
      `  ${icon} ${resource.name}: ${resource.action} (${resource.status})`,
    );
  }

  if (result.issues.length > 0) {
    console.log(`\nIssues (${String(result.issues.length)}):`);
    for (const issue of result.issues) {
      console.log(`  ⚠ ${issue.resource}: ${issue.message}`);
    }
  }
}

function printApply(result: {
  readonly resources: readonly {
    readonly name: string;
    readonly action: string;
    readonly status: string;
  }[];
  readonly issues: readonly {
    readonly resource: string;
    readonly message: string;
  }[];
}): void {
  console.log("Apply results:");
  console.log("──────────────");

  if (result.resources.length === 0) {
    console.log("  (no resources)");
  }

  for (const resource of result.resources) {
    const icon = resource.status === "success" ? "✓" : "✗";
    console.log(
      `  ${icon} ${resource.name}: ${resource.action} (${resource.status})`,
    );
  }

  if (result.issues.length > 0) {
    console.log(`\nIssues (${String(result.issues.length)}):`);
    for (const issue of result.issues) {
      console.log(`  ⚠ ${issue.resource}: ${issue.message}`);
    }
  }

  const failed = result.resources.filter((r) => r.status === "failed").length;
  if (failed > 0) {
    console.log(`\n${String(failed)} resource(s) failed.`);
    process.exit(1);
  }

  console.log("\nAll resources applied successfully.");
}

function printDrift(result: {
  readonly totalResources: number;
  readonly driftedResources: readonly {
    readonly name: string;
    readonly action: string;
  }[];
  readonly issues: readonly {
    readonly resource: string;
    readonly message: string;
  }[];
  readonly hasDrift: boolean;
}): void {
  console.log("Drift detection:");
  console.log("────────────────");

  console.log(`  Total resources: ${String(result.totalResources)}`);
  console.log(`  Drifted: ${String(result.driftedResources.length)}`);

  if (result.hasDrift) {
    console.log("\n  Drifted resources:");
    for (const resource of result.driftedResources) {
      console.log(`    • ${resource.name}: would ${resource.action}`);
    }
  } else {
    console.log(
      "\n  No drift detected — all resources match desired configuration.",
    );
  }

  if (result.issues.length > 0) {
    console.log(`\nIssues (${String(result.issues.length)}):`);
    for (const issue of result.issues) {
      console.log(`  ⚠ ${issue.resource}: ${issue.message}`);
    }
  }

  if (result.hasDrift) {
    process.exit(1);
  }
}
