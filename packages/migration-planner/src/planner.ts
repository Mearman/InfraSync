/**
 * Core migration planner engine.
 *
 * Compares TerraformIR and InfraIR documents, producing a classified
 * MigrationPlan with executable steps.
 */
import type {
  TerraformIR,
  TerraformResourceIR,
} from "@infrasync/core-ir/schemas";
import type { InfraIR, ResourceIR } from "@infrasync/core/types";
import type {
  MigrationPlan,
  MigrationDirection,
  ResourceChange,
  MigrationSummary,
  SafetyClassification,
  AttributeDiff,
  MitigationStrategy,
} from "./schemas.js";
import { PluginRegistry } from "./plugin-registry.js";
import { matchResources } from "./resource-matcher.js";
import { diffAttributes } from "./attribute-differ.js";
import { generateSteps } from "./step-generator.js";

export interface PlannerOptions {
  direction: MigrationDirection;
  registry: PluginRegistry;
}

/**
 * Compare two IR documents and produce a migration plan.
 */
export function compare(
  tfIR: TerraformIR,
  infraIR: InfraIR,
  options: PlannerOptions,
): MigrationPlan {
  const { direction, registry } = options;
  const warnings: string[] = [];

  // Match resources between the two IRs
  const pairs = matchResources(tfIR, infraIR.resources, registry);

  // Diff each pair
  const changes: ResourceChange[] = [];
  for (const pair of pairs) {
    const change = diffPair(pair, registry, direction);
    changes.push(change);
  }

  // Generate steps
  const steps = generateSteps(changes, direction);

  // Compute summary
  const summary = computeSummary(changes);

  // Warnings
  if (changes.some((c) => c.action === "unresolvable")) {
    warnings.push(
      "Some resources could not be matched between Terraform and InfraSync. These require manual intervention.",
    );
  }
  if (summary.destructive > 0) {
    warnings.push(
      `${String(summary.destructive)} resource(s) have destructive changes that require manual confirmation.`,
    );
  }

  return {
    direction,
    changes,
    steps,
    summary,
    warnings,
  };
}

function diffPair(
  pair: {
    tfResource?: TerraformResourceIR;
    infraResource?: ResourceIR;
    tfKey?: { name: string; type: string; provider: string };
    infraKey?: { name: string; type: string; provider: string };
  },
  registry: PluginRegistry,
  direction: MigrationDirection,
): ResourceChange {
  const { tfResource, infraResource, tfKey, infraKey } = pair;

  // Unresolvable — no TF resource and no mapping
  if (tfResource === undefined && infraResource === undefined) {
    // Should not happen from matcher, but handle defensively
    return {
      action: "unresolvable",
      attributeDiffs: [],
      safety: "destructive",
    };
  }

  // Create — only exists in one side
  if (tfResource === undefined) {
    return {
      infraKey,
      action: "create",
      attributeDiffs: [],
      safety: "safe",
    };
  }
  if (infraResource === undefined) {
    // Could be unresolvable (no mapping) or delete
    const hasMapping =
      registry.resolveInfraKind(tfResource.addressParts.type) !== undefined;
    if (!hasMapping) {
      return {
        tfKey,
        action: "unresolvable",
        attributeDiffs: [],
        safety: "destructive",
      };
    }
    return {
      tfKey,
      action: "delete",
      attributeDiffs: [],
      safety: "risky",
    };
  }

  // Both exist — diff them
  const adapterName = infraResource.provider;
  const rules = registry.safetyRulesFor(adapterName);

  const tfValues = tfResource.state?.values ?? {};
  const infraSpec = infraResource.spec;

  // Get attribute mappers to normalise paths
  const mappers = registry.attributeMappersFor(adapterName);

  // Diff the values (TF state values) against InfraSync spec
  const attributeDiffs = diffAttributes({
    basePath: "spec",
    before: normaliseForComparison(tfValues, mappers),
    after: normaliseForComparison(infraSpec, mappers),
    rules,
    direction,
    action: "update",
  });

  if (attributeDiffs.length === 0) {
    return {
      tfKey,
      infraKey,
      action: "unchanged",
      attributeDiffs: [],
      safety: "safe",
    };
  }

  const safety = worstSafety(attributeDiffs.map((d) => d.safety));
  const mitigation = computeMitigation(attributeDiffs, tfResource);
  return {
    tfKey,
    infraKey,
    action: "update",
    attributeDiffs,
    safety,
    ...(mitigation !== undefined ? { mitigation } : {}),
  };
}

/**
 * Normalise attribute paths using mappers for consistent comparison.
 */
/**
 * Compute mitigation strategy from attribute diffs and TF lifecycle metadata.
 */
function computeMitigation(
  diffs: readonly AttributeDiff[],
  tfResource: TerraformResourceIR,
): MitigationStrategy | undefined {
  const destructiveDiffs = diffs.filter((d) => d.safety === "destructive");
  if (destructiveDiffs.length === 0) return undefined;

  // Check if TF lifecycle specifies create_before_destroy
  const lifecycle = tfResource.config?.meta.lifecycle;
  if (lifecycle?.preventDestroy === true) {
    return {
      automated: false,
      strategy: "none",
      preservesData: false,
      requiresDowntime: true,
      description:
        "Resource has prevent_destroy enabled — destruction is blocked",
    };
  }

  // Check if any destructive diff has a mitigation from plugin rules
  const mitigations = destructiveDiffs
    .map((d) => d.mitigation)
    .filter((m): m is NonNullable<typeof m> => m !== undefined);

  // Prefer create-before-destroy if available
  if (
    mitigations.includes("create-before-destroy") ||
    lifecycle?.createBeforeDestroy === true
  ) {
    return {
      automated: true,
      strategy: "create-before-destroy",
      preservesData: true,
      requiresDowntime: false,
      description:
        "Destructive changes can be automated using create-before-destroy strategy — new resource created before old is destroyed",
    };
  }

  // In-place replace if all destructive diffs support it
  if (
    mitigations.length > 0 &&
    mitigations.every((m) => m === "in-place-replace")
  ) {
    return {
      automated: true,
      strategy: "in-place-replace",
      preservesData: true,
      requiresDowntime: false,
      description:
        "Destructive changes can be automated using in-place replacement",
    };
  }

  // Default: destroy-before-create (requires confirmation)
  return {
    automated: false,
    strategy: "destroy-before-create",
    preservesData: false,
    requiresDowntime: true,
    description:
      "Destructive changes require destroy-before-create — data loss possible, manual intervention recommended",
  };
}

function normaliseForComparison(
  values: Record<string, unknown>,
  mappers: readonly { tfPath: string; infraPath: string }[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    // Normalise both TF and InfraSync paths to a canonical form (infra path)
    const mapper = mappers.find((m) => m.tfPath === `spec.${key}`);
    if (mapper !== undefined) {
      // TF path → infra path
      const normalisedKey = mapper.infraPath.replace(/^spec\./, "");
      result[normalisedKey] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function worstSafety(
  classifications: readonly SafetyClassification[],
): SafetyClassification {
  if (classifications.includes("destructive")) return "destructive";
  if (classifications.includes("risky")) return "risky";
  return "safe";
}

function computeSummary(changes: readonly ResourceChange[]): MigrationSummary {
  let unchanged = 0;
  let safe = 0;
  let risky = 0;
  let destructive = 0;
  let creates = 0;
  let deletes = 0;
  let updates = 0;

  for (const change of changes) {
    switch (change.action) {
      case "unchanged":
        unchanged++;
        break;
      case "create":
        creates++;
        safe++;
        break;
      case "delete":
        deletes++;
        risky++;
        break;
      case "update":
        updates++;
        if (change.safety === "destructive") destructive++;
        else if (change.safety === "risky") risky++;
        else safe++;
        break;
      case "unresolvable":
        destructive++;
        break;
    }
  }

  return {
    total: changes.length,
    unchanged,
    safe,
    risky,
    destructive,
    creates,
    deletes,
    updates,
  };
}
