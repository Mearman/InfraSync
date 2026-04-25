import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { InfraIR } from "@infrasync/core/types";
import { cdktfTypeScriptExporter } from "../exporters/cdktf-ts.js";

export interface ExportCdktfTypeScriptOptions {
  readonly outDir: string;
  readonly stackName?: string;
  readonly providerSources?: Readonly<Record<string, string>>;
}

export interface ExportCdktfTypeScriptOutput {
  readonly outDir: string;
  readonly files: readonly string[];
  readonly warnings: readonly {
    readonly code: string;
    readonly message: string;
  }[];
}

/**
 * Export an InfraIR document as a CDKTF TypeScript project.
 */
export async function exportCdktfTypeScript(
  ir: InfraIR,
  options: ExportCdktfTypeScriptOptions,
): Promise<ExportCdktfTypeScriptOutput> {
  const outDir = resolve(options.outDir);

  const exportOptions: {
    stackName?: string;
    providerSources?: Readonly<Record<string, string>>;
  } = {};

  if (options.stackName !== undefined) {
    exportOptions.stackName = options.stackName;
  }

  if (options.providerSources !== undefined) {
    exportOptions.providerSources = options.providerSources;
  }

  const generated = await cdktfTypeScriptExporter.generate(ir, exportOptions);

  await mkdir(outDir, { recursive: true });

  const files: string[] = [];
  for (const file of generated.files) {
    const targetPath = join(outDir, file.path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, "utf-8");
    files.push(targetPath);
  }

  return {
    outDir,
    files,
    warnings: generated.warnings,
  };
}
