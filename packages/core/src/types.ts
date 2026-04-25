/**
 * InfraSync IR types.
 *
 * Canonical definitions live in `schemas.ts` (Zod schemas).
 * This module re-exports the inferred types for backward compatibility
 * with existing imports: `import type { InfraIR } from "./types.js"`.
 *
 * Runtime schemas and JSON Schema exports are available from `schemas.ts`.
 */

export type {
  RefTokenIR,
  RefBindingIR,
  SecretSourceIR,
  ProviderInstanceIR,
  ResourceIR,
  InfraIR,
} from "./schemas.js";
