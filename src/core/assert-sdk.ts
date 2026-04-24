import { z } from "zod";
import type { ZodType } from "zod";

// ─── Diagnostic type for compile-time errors ─────────────────────────────────

/**
 * Shown in the TypeScript error when a Zod schema's fields don't align
 * with the SDK response type. Provides structured diagnostics.
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
 * SDK types from generated packages (Cloudflare, AWS, etc.) use `interface`
 * which doesn't satisfy `Record<string, unknown>` due to missing index
 * signatures. This function accepts any SDK type and extracts its keys
 * via `keyof TSdk` — no index signature required.
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
 * For custom/internal providers without SDK types, this function is not needed —
 * the apiResponseSchema itself is the contract.
 */
export function assertSdkCoverage<TSdk>(): <S extends ZodType>(
  _schema: [keyof z.infer<S>] extends [keyof TSdk]
    ? z.infer<S> extends Pick<
        TSdk & Record<string, unknown>,
        keyof z.infer<S> & keyof TSdk
      >
      ? S
      : SdkMismatch<TSdk, z.infer<S>>
    : SdkMismatch<TSdk, z.infer<S>>,
) => void {
  return () => {
    // Compile-time assertion only — intentionally empty at runtime
  };
}
