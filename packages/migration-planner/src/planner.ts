/**
 * Core migration planner engine.
 *
 * Compares TerraformIR and InfraIR documents, producing a classified
 * MigrationPlan with executable steps.
 */
import type {
  TerraformIR,
  TerraformResourceIR,
} from "@infrasync-org/core-ir/schemas";
import type { InfraIR, ResourceIR } from "@infrasync-org/core/types";
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
  const rawDiffs = diffAttributes({
    basePath: "spec",
    before: normaliseForComparison(tfValues, mappers),
    after: normaliseForComparison(infraSpec, mappers),
    rules,
    direction,
    action: "update",
  });

  // Apply ignore_changes from TF lifecycle metadata
  const ignoreChanges = tfResource.config?.meta.lifecycle?.ignoreChanges;
  const attributeDiffs =
    ignoreChanges !== undefined && ignoreChanges.length > 0
      ? filterIgnoredChanges(rawDiffs, ignoreChanges)
      : rawDiffs;

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
 * Filter out attribute diffs that match the TF lifecycle ignore_changes list.
 *
 * ignore_changes paths are relative to the resource, e.g. ["tags", "ttl"].
 * Diff paths use "spec." prefix, so we match against the suffix.
 */
function filterIgnoredChanges(
  diffs: readonly AttributeDiff[],
  ignoreChanges: readonly string[],
): AttributeDiff[] {
  const ignoredSet = new Set(ignoreChanges);
  return diffs.filter((diff) => {
    // Strip the "spec." prefix for matching
    const relativePath = diff.path.replace(/^spec\./, "");
    // Direct match or prefix match (e.g. "tags" matches "tags.foo")
    for (const ignored of ignoredSet) {
      if (relativePath === ignored || relativePath.startsWith(`${ignored}.`)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Normalise attribute paths using mappers for consistent comparison.
 */
/**
 * Compute mitigation strategy from attribute diffs and TF lifecycle metadata.
 *
 * Resolution order (first match wins):
 *   1. replace_triggered_by — if a destructive diff matches a triggered path,
 *      force CBD regardless of other rules
 *   2. prevent_destroy — blocks all automated replacement (unless overridden
 *      by replace_triggered_by, matching Terraform behaviour)
 *   3. create_before_destroy lifecycle — promotes to CBD
 *   4. Plugin rule mitigations — CBD if any rule requests it, in-place-replace
 *      if all destructive diffs support it
 *   5. Default: destroy-before-create (not automated, requires confirmation)
 */
function computeMitigation(
  diffs: readonly AttributeDiff[],
  tfResource: TerraformResourceIR,
): MitigationStrategy | undefined {
  const destructiveDiffs = diffs.filter((d) => d.safety === "destructive");
  const hasDestructive = destructiveDiffs.length > 0;

  const lifecycle = tfResource.config?.meta.lifecycle;
  const replaceTriggeredBy = lifecycle?.replaceTriggeredBy;
  const preventDestroy = lifecycle?.preventDestroy === true;
  const createBeforeDestroy = lifecycle?.createBeforeDestroy === true;

  // 1. replace_triggered_by — check ALL diffs, not just destructive.
  // In Terraform, replace_triggered_by forces replacement regardless of safety.
  if (replaceTriggeredBy !== undefined && replaceTriggeredBy.length > 0) {
    const triggered = isTriggeredByReplace(diffs, replaceTriggeredBy);
    if (triggered) {
      return {
        automated: true,
        strategy: "create-before-destroy",
        preservesData: true,
        requiresDowntime: false,
        description:
          "Resource has replace_triggered_by matching changed attributes — forces create-before-destroy replacement",
      };
    }
  }

  // If no destructive diffs and no replace_triggered_by match, no mitigation needed
  if (!hasDestructive) return undefined;

  // Collect plugin rule mitigations for destructive diffs
  const mitigations = destructiveDiffs
    .map((d) => d.mitigation)
    .filter((m): m is NonNullable<typeof m> => m !== undefined);

  // 2. prevent_destroy — blocks automated replacement
  if (preventDestroy) {
    return {
      automated: false,
      strategy: "none",
      preservesData: false,
      requiresDowntime: true,
      description:
        "Resource has prevent_destroy enabled — destruction is blocked. Requires manual override.",
    };
  }

  // 3. create_before_destroy lifecycle
  if (createBeforeDestroy) {
    return {
      automated: true,
      strategy: "create-before-destroy",
      preservesData: true,
      requiresDowntime: false,
      description:
        "Resource has create_before_destroy enabled — new resource created before old is destroyed",
    };
  }

  // 4. Plugin rule mitigations
  // CBD if any rule requests it
  if (mitigations.includes("create-before-destroy")) {
    return {
      automated: true,
      strategy: "create-before-destroy",
      preservesData: true,
      requiresDowntime: false,
      description:
        "Destructive changes can be automated using create-before-destroy strategy (from plugin rule)",
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

  // 5. Default: destroy-before-create (not automated, requires confirmation)
  return {
    automated: false,
    strategy: "destroy-before-create",
    preservesData: false,
    requiresDowntime: true,
    description:
      "Destructive changes require destroy-before-create — data loss possible, manual intervention recommended",
  };
}

/**
 * Check if any destructive diff path matches a replace_triggered_by entry.
 *
 * replace_triggered_by paths are relative to the resource (e.g. ["tags",
 * "type"]). Diff paths use "spec." prefix, so we strip it for matching.
 * Supports exact match and prefix match (e.g. "tags" matches "tags.foo").
 */
function isTriggeredByReplace(
  destructiveDiffs: readonly AttributeDiff[],
  replaceTriggeredBy: readonly string[],
): boolean {
  const triggeredSet = new Set(replaceTriggeredBy);

  for (const diff of destructiveDiffs) {
    const relativePath = diff.path.replace(/^spec\./, "");
    for (const triggered of triggeredSet) {
      if (
        relativePath === triggered ||
        relativePath.startsWith(`${triggered}.`)
      ) {
        return true;
      }
    }
  }

  return false;
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
