/**
 * Canonical Zod schemas for fidelity reporting.
 *
 * Types are inferred from these schemas. Parse only at adapter boundaries.
 */
import * as z from "zod";

// ─── Fidelity classification ─────────────────────────────────────────────────

export const fidelityClassSchema = z.enum(["lossless", "lossy", "unsupported"]);

// ─── Fidelity issue ──────────────────────────────────────────────────────────

export const fidelityIssueSchema = z.object({
  path: z
    .string()
    .trim()
    .meta({ description: "Dot-notation path within the source document" }),
  class: fidelityClassSchema.describe("Classification of the issue"),
  message: z
    .string()
    .trim()
    .meta({ description: "Human-readable explanation" }),
  action: z.enum([
    "preserved_in_extension",
    "approximated",
    "dropped",
    "unsupported_version",
    "unknown_field_ignored",
  ]),
});

// ─── Fidelity report ─────────────────────────────────────────────────────────

export const fidelityReportSchema = z.object({
  overall: fidelityClassSchema.describe(
    "The worst fidelity class across all issues",
  ),
  issues: z.array(fidelityIssueSchema),
});

// ─── Adapter result ──────────────────────────────────────────────────────────

export function adapterResultSchema<T extends z.ZodType>(documentSchema: T) {
  return z.object({
    document: documentSchema,
    fidelity: fidelityReportSchema,
    warnings: z.array(z.string().trim()),
  });
}

// ─── Inferred types ──────────────────────────────────────────────────────────

export type FidelityClass = z.infer<typeof fidelityClassSchema>;
export type FidelityIssue = z.infer<typeof fidelityIssueSchema>;
export type FidelityReport = z.infer<typeof fidelityReportSchema>;
export interface AdapterResult<T> {
  readonly document: T;
  readonly fidelity: FidelityReport;
  readonly warnings: readonly string[];
}

// ─── JSON Schema exports ─────────────────────────────────────────────────────

export const fidelityReportJsonSchema = z.toJSONSchema(fidelityReportSchema);
