import type { InfraIR } from "@infrasync-org/core/types";

/** A generated file, with its relative path under the export directory. */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

/** A warning emitted during export generation. */
export interface ExportWarning {
  readonly code: string;
  readonly message: string;
}

/** Result from an exporter run. */
export interface ExportResult {
  readonly files: readonly GeneratedFile[];
  readonly warnings: readonly ExportWarning[];
}

/** Common interface for export generators. */
export interface Exporter<TOptions> {
  readonly format: string;
  generate(ir: InfraIR, options: TOptions): Promise<ExportResult>;
}
