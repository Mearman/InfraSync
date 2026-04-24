import { createJiti } from "jiti";
import type { InfraResult } from "../authoring/compiler.js";
import type { ProviderAdapter } from "../core/provider.js";

// ─── Config file interface ───────────────────────────────────────────────────

/**
 * The expected shape of an InfraSync config file.
 *
 * The config file must have a default export that is the result of `defineInfra()`.
 * It may also export an `adapters` record for custom adapters.
 *
 * ```typescript
 * // infra.config.ts
 * import { defineInfra, cloudflare } from "infrasync";
 *
 * export default defineInfra("prod", (infra) => {
 *   const cf = infra.provider("cf", cloudflare, { ... });
 *   // ...
 * });
 *
 * export const adapters = { cloudflare };
 * ```
 */
export interface InfraConfig<TOutputs = unknown> {
  readonly infraResult: InfraResult<TOutputs>;
  readonly adapters?: Record<string, ProviderAdapter> | undefined;
}

// ─── Type guard ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow an unknown value to InfraResult.
 * Checks for the required `toIR` method and `name` property.
 */
function isInfraResult(value: unknown): value is InfraResult<unknown> {
  if (!isRecord(value)) return false;
  if (!("toIR" in value) || typeof value.toIR !== "function") return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  return true;
}

// ─── Config loader ───────────────────────────────────────────────────────────

/**
 * Load an InfraSync config file.
 *
 * Uses `jiti` to handle TypeScript transpilation at runtime.
 * The config file must export `default` as an `InfraResult`.
 *
 * @param configPath - Path to the config file (e.g. "infra.config.ts")
 * @returns The loaded config with the InfraResult and optional adapters
 */
export async function loadConfig(configPath: string): Promise<InfraConfig> {
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
  });

  const module = await jiti.import(configPath);

  if (!isRecord(module)) {
    throw new Error(
      `Config file "${configPath}" must export an object with a default export`,
    );
  }

  // jiti with interopDefault may return the default export directly
  // when the module only has a default export.
  // Check both cases: { default: InfraResult } or InfraResult directly.
  const hasExplicitDefault = "default" in module;
  const infraResult = hasExplicitDefault ? module.default : module;

  if (!isInfraResult(infraResult)) {
    throw new Error(
      `Config file "${configPath}" default export must be an InfraResult from defineInfra() — missing toIR() method or name property`,
    );
  }

  const adaptersEntry = "adapters" in module ? module.adapters : undefined;
  const adapters: Record<string, ProviderAdapter> | undefined = isRecord(
    adaptersEntry,
  )
    ? Object.fromEntries(
        Object.entries(adaptersEntry).filter(
          (entry): entry is [string, ProviderAdapter] =>
            isRecord(entry[1]) &&
            "adapterName" in entry[1] &&
            "create" in entry[1],
        ),
      )
    : undefined;

  return {
    infraResult,
    adapters,
  };
}
