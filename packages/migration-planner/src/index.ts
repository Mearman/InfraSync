/**
 * @infrasync-org/migration-planner — public API.
 */
export { compare, type PlannerOptions } from "./planner.js";
export {
  executePlan,
  type ExecutionContext,
  type ExecutorOptions,
} from "./executor.js";
export { PluginRegistry } from "./plugin-registry.js";
export { diffAttributes } from "./attribute-differ.js";
export { matchResources } from "./resource-matcher.js";
export { generateSteps } from "./step-generator.js";
export { genericPlugin } from "./plugins/generic.js";
export { cloudflarePlugin } from "./plugins/cloudflare.js";
export type {
  MigrationPlan,
  MigrationDirection,
  MigrationSummary,
  MigrationStep,
  MigrationPlugin,
  ResourceChange,
  ResourceKey,
  AttributeDiff,
  SafetyClassification,
  ResourceAction,
  StepAction,
  StepTarget,
  ResourceMapping,
  SafetyRule,
  AttributeMapper,
  MitigationStrategy,
  StepStatus,
  StepOutcome,
  ExecutionResult,
} from "./schemas.js";
