import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig } from "./loader.js";
import { buildRegistry } from "./registry.js";
import { plan } from "./commands/plan.js";
import { apply } from "./commands/apply.js";
import { drift } from "./commands/drift.js";
import { cloudflare } from "../providers/cloudflare/index.js";

// ─── Built-in adapters ───────────────────────────────────────────────────────

/**
 * Built-in adapter registry. Always available without user configuration.
 * Users add custom adapters via the config file's `adapters` export.
 */
const builtinAdapters = buildRegistry({ cloudflare });

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
      description: "Path to a serialised InfraIR JSON file (low-level)",
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
  apply   Apply configuration from a config file
  plan    Preview changes without applying
  drift   Show drift between desired and actual state

Options:
  -c, --config <path>   Path to infra config file (default: infra.config.ts)
      --ir <path>       Path to serialised InfraIR JSON file
  -h, --help            Show this help message

Examples:
  infrasync apply --config infra.config.ts
  infrasync plan
  infrasync drift
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
    "Error: no command specified. Use 'plan', 'apply', or 'drift'.",
  );
  console.error("Run 'infrasync --help' for usage.");
  process.exit(1);
}

if (command !== "apply" && command !== "plan" && command !== "drift") {
  console.error(
    `Error: unknown command "${command}". Use 'plan', 'apply', or 'drift'.`,
  );
  process.exit(1);
}

// ─── IR file path (low-level) ────────────────────────────────────────────────

if (args.values.ir !== undefined) {
  // TODO: Load IR from JSON file and execute directly
  console.error("--ir flag is not yet implemented");
  process.exit(1);
}

// ─── Config file loading ─────────────────────────────────────────────────────

const configPath = resolve(args.values.config ?? "infra.config.ts");

run(command, configPath).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});

// ─── Main execution ──────────────────────────────────────────────────────────

async function run(
  command: "apply" | "plan" | "drift",
  configPath: string,
): Promise<void> {
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
