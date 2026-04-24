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
export {
  isRefToken,
  createRefToken,
  refable,
  refTokenToIR,
} from "./core/refs.js";
export type { RefToken } from "./core/refs.js";

// ─── SDK alignment ───────────────────────────────────────────────────────────
export { assertSdkCoverage } from "./core/assert-sdk.js";

// ─── Provider ports ──────────────────────────────────────────────────────────
export { defineProvider } from "./core/provider.js";
export type {
  ProviderPort,
  ResourcePort,
  ProviderAdapterFactory,
} from "./core/provider.js";
