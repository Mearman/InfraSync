// ─── CLI programmatic API ────────────────────────────────────────────────────

export { buildRegistry } from "./cli/registry.js";
export type { AdapterRegistry } from "./cli/registry.js";
export { loadConfig } from "./cli/loader.js";
export type { InfraConfig } from "./cli/loader.js";
export { plan } from "./cli/commands/plan.js";
export type { PlanOutput } from "./cli/commands/plan.js";
export { apply } from "./cli/commands/apply.js";
export type { ApplyOutput } from "./cli/commands/apply.js";
export { drift } from "./cli/commands/drift.js";
export type { DriftOutput } from "./cli/commands/drift.js";
