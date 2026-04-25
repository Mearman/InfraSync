/**
 * Fidelity reporting runtime utilities.
 *
 * Types and schemas live in `schemas.ts`. This module provides the
 * `FidelityReportBuilder` for constructing reports during adapter operations.
 */

import type { FidelityClass, FidelityIssue, AdapterResult } from "./schemas.js";

export type {
  FidelityClass,
  FidelityIssue,
  FidelityReport,
  AdapterResult,
} from "./schemas.js";

// ─── Report builder ──────────────────────────────────────────────────────────

/**
 * Accumulates fidelity issues during a translation and computes the
 * overall fidelity class.
 */
export class FidelityReportBuilder {
  private readonly issues: FidelityIssue[] = [];
  private readonly warnings: string[] = [];

  addIssue(issue: FidelityIssue): void {
    this.issues.push(issue);
  }

  addWarning(message: string): void {
    this.warnings.push(message);
  }

  get overall(): FidelityClass {
    if (this.issues.some((issue) => issue.class === "unsupported")) {
      return "unsupported";
    }
    if (this.issues.some((issue) => issue.class === "lossy")) {
      return "lossy";
    }
    return "lossless";
  }

  build() {
    return {
      overall: this.overall,
      issues: this.issues,
    };
  }

  buildWarnings(): readonly string[] {
    return this.warnings;
  }

  /**
   * Wrap a translated document with the fidelity report and warnings.
   */
  result<T>(document: T): AdapterResult<T> {
    return {
      document,
      fidelity: this.build(),
      warnings: this.buildWarnings(),
    };
  }
}
