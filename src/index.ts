// ─── IR types ────────────────────────────────────────────────────────────────
export type {
  InfraIR,
  ProviderInstanceIR,
  ResourceIR,
  RefTokenIR,
  RefBindingIR,
  SecretSourceIR,
} from "./ir/types.js";

// ─── Core errors ─────────────────────────────────────────────────────────────
export { ProviderApiError, DagCycleError } from "./core/errors.js";

// ─── Refs ────────────────────────────────────────────────────────────────────
export { RefToken, isRefToken, refable, refTokenToIR } from "./core/refs.js";

// ─── SDK alignment ───────────────────────────────────────────────────────────
export { assertSdkCoverage } from "./core/assert-sdk.js";

// ─── Provider ports ──────────────────────────────────────────────────────────
export { defineProvider } from "./core/provider.js";
export type {
  ProviderPort,
  ResourcePort,
  ProviderAdapter,
} from "./core/provider.js";

// ─── Authoring: handles ──────────────────────────────────────────────────────
export type {
  ResourceHandle,
  ProviderHandle,
  ResourceOptions,
} from "./authoring/handles.js";

// ─── Authoring: infra ────────────────────────────────────────────────────────
export { InfraScope } from "./authoring/infra.js";
export type {
  SecretHelper,
  DeclarativeResource,
  DeclarativeFragment,
  ProviderRegistration,
} from "./authoring/infra.js";

// ─── Authoring: declarative ──────────────────────────────────────────────────
export { declarative } from "./authoring/declarative.js";

// ─── Authoring: compiler ─────────────────────────────────────────────────────
export { defineInfra, compileToIR } from "./authoring/compiler.js";
export type { InfraResult } from "./authoring/compiler.js";
