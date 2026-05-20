import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import { infraIRSchema } from "@infrasync-org/core/schemas";
import type { InfraIR } from "@infrasync-org/core/types";
import type { ProviderAdapter } from "@infrasync-org/core/provider";

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Load and validate a serialised InfraIR JSON file.
 *
 * Reads the file, parses JSON, and validates the shape against
 * the IR schema. Returns validated data ready for the sync engine.
 *
 * @param irPath - Path to the JSON file
 * @returns Validated InfraIR
 * @throws Error if the file cannot be read, parsed, or validated
 */
export async function loadIR(irPath: string): Promise<InfraIR> {
  const absolute = resolve(irPath);
  const raw = await readFile(absolute, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON from "${absolute}"`);
  }

  const result = infraIRSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.map(String).join(".");
        return path.length > 0
          ? `  ${path}: ${issue.message}`
          : `  ${issue.message}`;
      })
      .join("\n");
    throw new Error(`Invalid InfraIR in "${absolute}":\n${issues}`);
  }

  return result.data;
}

// ─── Adapter loader ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderAdapter(value: unknown): value is ProviderAdapter {
  return isRecord(value) && "adapterName" in value && "create" in value;
}

/**
 * Load provider adapters from a TS/JS module.
 *
 * The module must export a `Record<string, ProviderAdapter>` (default or named).
 * Uses jiti for TypeScript support.
 *
 * @param adaptersPath - Path to the adapters module
 * @returns Validated adapter record
 * @throws Error if the module cannot be loaded or has no valid adapters
 */
export async function loadAdapters(
  adaptersPath: string,
): Promise<Record<string, ProviderAdapter>> {
  const absolute = resolve(adaptersPath);
  const jiti = createJiti(import.meta.url, { interopDefault: true });

  const module = await jiti.import(absolute);

  if (!isRecord(module)) {
    throw new Error(
      `Adapters module "${absolute}" must export an object with adapter entries`,
    );
  }

  const adapters: Record<string, ProviderAdapter> = {};
  let count = 0;

  for (const [key, value] of Object.entries(module)) {
    if (isProviderAdapter(value)) {
      adapters[key] = value;
      count++;
    }
  }

  if (count === 0) {
    throw new Error(
      `Adapters module "${absolute}" contains no valid ProviderAdapter exports`,
    );
  }

  return adapters;
}
