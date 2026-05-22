/**
 * Inventory — environment-level provider configuration for InfraSync.
 *
 * Inventory files map provider instance keys to their configuration values,
 * with environment variable interpolation. This lets the same infra definition
 * target different environments (staging, production) by swapping the
 * inventory file.
 *
 * This is a CLI-level concern. The core engine receives a fully-resolved
 * InfraIR — it doesn't know about inventory.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as z from "zod";
import { parse as parseYaml } from "yaml";
import type { InfraIR, ProviderInstanceIR } from "@infrasync-org/core/types";

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Zod schema for inventory files.
 *
 * Structure: `{ providers: { [providerKey]: { [configField]: value } } }`
 */
export const inventorySchema = z.object({
  providers: z.record(z.string(), z.record(z.string(), z.unknown())).meta({
    description:
      "Map of provider instance keys to their configuration overrides",
  }),
});

/** Validated inventory data. */
export type Inventory = z.infer<typeof inventorySchema>;

// ─── Environment variable interpolation ──────────────────────────────────────

/** Pattern matching `${VAR_NAME}` in string values. */
const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Interpolate `${VAR}` patterns in a single string value.
 *
 * Replaces all `${VAR}` occurrences with the corresponding environment
 * variable. Throws a descriptive error if a required variable is not set.
 */
function interpolateString(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(
        `Missing required environment variable "${varName}" referenced in inventory as "${match}"`,
      );
    }
    return envValue;
  });
}

/**
 * Recursively interpolate `${VAR}` patterns in a config value.
 *
 * Walks objects and arrays, replacing `${VAR}` in string values.
 * Non-string values (numbers, booleans, null) are left untouched.
 */
function interpolateConfigValue(value: unknown): unknown {
  if (typeof value === "string") {
    return interpolateString(value);
  }

  if (Array.isArray(value)) {
    return value.map(interpolateConfigValue);
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = interpolateConfigValue(val);
    }
    return result;
  }

  return value;
}

/**
 * Interpolate `${VAR}` patterns throughout an Inventory.
 *
 * Returns a new Inventory with all string values interpolated.
 */
function interpolateInventory(inventory: Inventory): Inventory {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [key, config] of Object.entries(inventory.providers)) {
    providers[key] = Object.fromEntries(
      Object.entries(config).map(([field, value]) => [
        field,
        interpolateConfigValue(value),
      ]),
    );
  }
  return { providers };
}

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Load an inventory file from disk.
 *
 * Supports YAML (`.yaml` / `.yml`) and JSON (`.json` or any other extension).
 * Parses the content, validates the structure with Zod, and interpolates
 * environment variable references in all string values.
 *
 * @param path - File path to the inventory file
 * @returns Validated inventory with env vars interpolated
 * @throws Error if the file cannot be read, parsed, validated, or if a
 *   required env var is missing
 */
export async function loadInventory(path: string): Promise<Inventory> {
  const absolute = resolve(path);
  const raw = await readFile(absolute, "utf-8");

  let parsed: unknown;

  if (absolute.endsWith(".yaml") || absolute.endsWith(".yml")) {
    parsed = parseYaml(raw);
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Failed to parse JSON from "${absolute}"`);
    }
  }

  const result = inventorySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const pathStr = issue.path.map(String).join(".");
        return pathStr.length > 0
          ? `  ${pathStr}: ${issue.message}`
          : `  ${issue.message}`;
      })
      .join("\n");
    throw new Error(`Invalid inventory in "${absolute}":\n${issues}`);
  }

  return interpolateInventory(result.data);
}

// ─── Deep merge ──────────────────────────────────────────────────────────────

/**
 * Deep-merge two configuration objects.
 *
 * For nested objects, recursively merges. For all other types (including
 * arrays), the override value wins. The base object is not mutated.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = result[key];

    if (isRecord(baseValue) && isRecord(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Merge into InfraIR ──────────────────────────────────────────────────────

/**
 * Merge inventory configuration into an InfraIR.
 *
 * For each provider in the IR, if the inventory contains a matching key,
 * the inventory values are deep-merged on top of the existing config.
 * Providers not present in the inventory are left unchanged.
 * Provider keys in the inventory that don't match any IR provider are ignored.
 *
 * @param infraIR - The compiled InfraIR
 * @param inventory - Loaded and interpolated inventory
 * @returns A new InfraIR with provider configs merged
 */
export function mergeInventoryConfig(
  infraIR: InfraIR,
  inventory: Inventory,
): InfraIR {
  const inventoryMap = new Map(Object.entries(inventory.providers));

  const providers: ProviderInstanceIR[] = infraIR.providers.map((provider) => {
    const inventoryConfig = inventoryMap.get(provider.key);
    if (inventoryConfig === undefined) {
      return provider;
    }

    return {
      ...provider,
      config: deepMerge(provider.config, inventoryConfig),
    };
  });

  return {
    ...infraIR,
    providers,
  };
}
