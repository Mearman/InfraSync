/**
 * Migration step generator.
 *
 * Produces executable MigrationStep entries from ResourceChange diffs,
 * ordered by dependencies (creates before updates, deletes after updates).
 */
import type {
  ResourceChange,
  MigrationStep,
  MigrationDirection,
  StepAction,
  StepTarget,
  SafetyClassification,
  AttributeDiff,
} from "./schemas.js";

/** Mutable step builder — converted to MigrationStep when finalised */
interface StepBuilder {
  id: string;
  action: StepAction;
  target: StepTarget;
  resourceType: string;
  resourceName: string;
  description: string;
  safety: SafetyClassification;
  dependsOn: string[];
  payload: unknown;
  requiresConfirmation: boolean;
}

export function generateSteps(
  changes: readonly ResourceChange[],
  direction: MigrationDirection,
): MigrationStep[] {
  const createSteps: StepBuilder[] = [];
  const updateSteps: StepBuilder[] = [];
  const deleteSteps: StepBuilder[] = [];
  const manualSteps: StepBuilder[] = [];

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (change === undefined) continue;

    const builder = buildStepBuilder(change, i, direction);
    if (builder === undefined) continue;

    switch (builder.action) {
      case "create":
        createSteps.push(builder);
        break;
      case "update":
        updateSteps.push(builder);
        break;
      case "replace-create":
        createSteps.push(builder);
        // Generate paired replace-destroy step
        deleteSteps.push({
          id: `${builder.id}-destroy`,
          action: "replace-destroy",
          target: builder.target,
          resourceType: builder.resourceType,
          resourceName: builder.resourceName,
          description: describeReplaceDestroy(
            builder.resourceType,
            builder.resourceName,
          ),
          safety: builder.safety,
          dependsOn: [builder.id],
          payload: builder.payload,
          requiresConfirmation: false,
        });
        break;
      case "replace-destroy":
        deleteSteps.push(builder);
        break;
      case "delete":
        deleteSteps.push(builder);
        break;
      case "manual-intervention":
        manualSteps.push(builder);
        break;
    }
  }

  // Wire dependencies: creates first, then updates, then deletes
  const priorStepIds: string[] = [];
  for (const group of [createSteps, updateSteps, deleteSteps]) {
    for (const builder of group) {
      builder.dependsOn.push(...priorStepIds);
    }
    priorStepIds.push(...group.map((b) => b.id));
  }

  // Manual steps depend on everything
  for (const builder of manualSteps) {
    builder.dependsOn.push(...priorStepIds);
  }

  // Verify steps
  const allActionable = [...createSteps, ...updateSteps];
  const verifyBuilders = generateVerifyBuilders(allActionable);
  for (const builder of verifyBuilders) {
    builder.dependsOn.push(...priorStepIds);
  }

  // Finalise to readonly MigrationStep[]
  const allBuilders = [
    ...createSteps,
    ...updateSteps,
    ...deleteSteps,
    ...manualSteps,
    ...verifyBuilders,
  ];
  return allBuilders.map(finaliseStep);
}

function finaliseStep(builder: StepBuilder): MigrationStep {
  return {
    id: builder.id,
    action: builder.action,
    target: builder.target,
    resourceType: builder.resourceType,
    resourceName: builder.resourceName,
    description: builder.description,
    safety: builder.safety,
    dependsOn: builder.dependsOn,
    payload: builder.payload,
    requiresConfirmation: builder.requiresConfirmation,
  };
}

function buildStepBuilder(
  change: ResourceChange,
  index: number,
  direction: MigrationDirection,
): StepBuilder | undefined {
  if (change.action === "unchanged") return undefined;

  // Unresolvable → always manual intervention
  if (change.action === "unresolvable") {
    return {
      id: `step-${String(index)}`,
      action: "manual-intervention",
      target: resolveTarget(change, direction),
      resourceType: resolveType(change),
      resourceName: resolveName(change),
      description: describeManualIntervention(change),
      safety: change.safety,
      dependsOn: [],
      payload: change,
      requiresConfirmation: true,
    };
  }

  // Destructive with automated mitigation → replace-create + replace-destroy
  if (
    change.safety === "destructive" &&
    change.mitigation?.automated === true
  ) {
    const target = resolveTarget(change, direction);
    return {
      id: `step-${String(index)}`,
      action: "replace-create",
      target,
      resourceType: resolveType(change),
      resourceName: resolveName(change),
      description: describeReplaceCreate(change),
      safety: change.safety,
      dependsOn: [],
      payload: change,
      requiresConfirmation: false,
    };
  }

  // Destructive without automated mitigation → manual intervention
  if (change.safety === "destructive") {
    return {
      id: `step-${String(index)}`,
      action: "manual-intervention",
      target: resolveTarget(change, direction),
      resourceType: resolveType(change),
      resourceName: resolveName(change),
      description: describeManualIntervention(change),
      safety: change.safety,
      dependsOn: [],
      payload: change,
      requiresConfirmation: true,
    };
  }

  const stepAction = resolveStepAction(change);
  const stepTarget = resolveTarget(change, direction);

  return {
    id: `step-${String(index)}`,
    action: stepAction,
    target: stepTarget,
    resourceType: resolveType(change),
    resourceName: resolveName(change),
    description: describeStep(change, stepAction, stepTarget),
    safety: change.safety,
    dependsOn: [],
    payload: change,
    requiresConfirmation: change.safety === "risky",
  };
}

function resolveStepAction(change: ResourceChange): StepAction {
  if (change.action === "create") return "create";
  if (change.action === "delete") return "delete";
  if (change.action === "update") return "update";
  return "manual-intervention";
}

function resolveTarget(
  change: ResourceChange,
  direction: MigrationDirection,
): StepTarget {
  if (change.action === "create") {
    return direction === "tf-to-infrasync" ? "infrasync" : "terraform";
  }
  if (change.action === "delete") {
    return direction === "tf-to-infrasync" ? "terraform" : "infrasync";
  }
  return direction === "tf-to-infrasync" ? "infrasync" : "terraform";
}

function resolveType(change: ResourceChange): string {
  return change.tfKey?.type ?? change.infraKey?.type ?? "unknown";
}

function resolveName(change: ResourceChange): string {
  return change.tfKey?.name ?? change.infraKey?.name ?? "unknown";
}

function describeStep(
  change: ResourceChange,
  action: StepAction,
  target: StepTarget,
): string {
  const name = resolveName(change);
  const type = resolveType(change);
  const safetyLabel =
    change.safety === "safe" ? "safely" : `with ${change.safety} changes`;
  const diffCount = String(change.attributeDiffs.length);

  switch (action) {
    case "create":
      return `Create ${type} "${name}" in ${target}`;
    case "update":
      return `Update ${type} "${name}" in ${target} (${safetyLabel}, ${diffCount} change(s))`;
    case "delete":
      return `Delete ${type} "${name}" from ${target}`;
    default:
      return `Process ${type} "${name}"`;
  }
}

function describeReplaceCreate(change: ResourceChange): string {
  const name = resolveName(change);
  const type = resolveType(change);
  const strategy = change.mitigation?.strategy ?? "create-before-destroy";
  const diffCount = String(change.attributeDiffs.length);
  return `Replace-create ${type} "${name}" (${strategy}, ${diffCount} destructive change(s)) — creates replacement before destroying old`;
}

function describeReplaceDestroy(
  resourceType: string,
  resourceName: string,
): string {
  return `Replace-destroy ${resourceType} "${resourceName}" — removes old resource after replacement is ready`;
}

function describeManualIntervention(change: ResourceChange): string {
  const name = resolveName(change);
  const type = resolveType(change);

  if (change.action === "unresolvable") {
    return `MANUAL: Cannot automatically migrate ${type} "${name}" — no matching resource mapping found. Review and handle manually.`;
  }

  const destructiveDiffs = change.attributeDiffs.filter(
    (d: AttributeDiff) => d.safety === "destructive",
  );
  const paths = destructiveDiffs.map((d: AttributeDiff) => d.path).join(", ");

  return `MANUAL: Destructive changes detected on ${type} "${name}" (${paths}). Requires delete + recreate. Confirm data loss is acceptable.`;
}

function generateVerifyBuilders(
  actionableBuilders: readonly StepBuilder[],
): StepBuilder[] {
  const verifyBuilders: StepBuilder[] = [];
  for (const builder of actionableBuilders) {
    if (builder.action === "manual-intervention") continue;

    verifyBuilders.push({
      id: `${builder.id}-verify`,
      action: "verify",
      target: builder.target,
      resourceType: builder.resourceType,
      resourceName: builder.resourceName,
      description: `Verify ${builder.resourceType} "${builder.resourceName}" after ${builder.action}`,
      safety: "safe",
      dependsOn: [builder.id],
      payload: undefined,
      requiresConfirmation: false,
    });
  }
  return verifyBuilders;
}
