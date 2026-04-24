import { z } from "zod";
import type { ZodType } from "zod";

// ─── Diagnostic type for compile-time errors ─────────────────────────────────

/**
 * Shown in the TypeScript error when a Zod schema's fields don't align
 * with the SDK response type. Provides structured diagnostics:
 * - missingFromSdk: fields in our schema that don't exist in the SDK type
 * - typeMismatches: fields where our schema type doesn't extend the SDK type
 */
interface SdkMismatch<TSdk, TSchema> {
  readonly "@error": "Zod schema fields do not match SDK response type";
  readonly schemaFields: keyof TSchema;
  readonly sdkFields: keyof TSdk;
  readonly missingFromSdk: Exclude<keyof TSchema, keyof TSdk>;
  readonly typeMismatches: {
    [K in keyof TSchema & keyof TSdk as TSchema[K] extends TSdk[K]
      ? never
      : K]: {
      readonly schemaType: TSchema[K];
      readonly sdkType: TSdk[K];
    };
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compile-time assertion that every field in a Zod schema exists in the SDK
 * response type with a structurally compatible type.
 *
 * At runtime this is a no-op. At compile time, if the SDK removes, renames,
 * or widens a field that our schema depends on, TypeScript produces an error
 * showing the mismatched fields.
 *
 * Usage in an adapter:
 *
 * ```typescript
 * import type { RecordResponse } from "cloudflare/resources/dns/records";
 * assertSdkCoverage<RecordResponse.CNAMERecord>()(cloudflareDnsStateSchema);
 * ```
 *
 * The constraint checks two things:
 * 1. All keys in our schema exist in the SDK type (no missing fields)
 * 2. Our schema's field types are assignable to the SDK's field types
 *    (narrower is fine — wider is an error)
 *
 * For custom/internal providers without SDK types, this function is not needed —
 * the apiResponseSchema itself is the contract.
 */
export function assertSdkCoverage<TSdk extends Record<string, unknown>>(): <
  S extends ZodType,
>(
  _schema: [keyof z.infer<S>] extends [keyof TSdk]
    ? z.infer<S> extends Pick<TSdk, keyof z.infer<S> & keyof TSdk>
      ? S
      : SdkMismatch<TSdk, z.infer<S>>
    : SdkMismatch<TSdk, z.infer<S>>,
) => void {
  // Intentionally empty — this function is a compile-time-only assertion.
  // It produces no runtime code; its purpose is to surface type errors
  // when a Zod schema drifts from the SDK response type it wraps.
  return () => {
    // Compile-time assertion only — intentionally empty at runtime
  };
}
