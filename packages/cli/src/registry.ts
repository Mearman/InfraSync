import type { ProviderAdapter } from "@infrasync-org/core/provider";

/**
 * Registry of available provider adapters, keyed by adapter name.
 *
 * The CLI builds this from built-in adapters and any custom adapters
 * exported by the config file.
 */
export type AdapterRegistry = Map<string, ProviderAdapter>;

/**
 * Build an adapter registry from a record of adapters.
 *
 * Merges built-in adapters with any custom adapters the user provides.
 *
 * Usage:
 *
 * ```typescript
 * import { cloudflare } from "infrasync/providers/cloudflare";
 *
 * const registry = buildRegistry({ cloudflare });
 * ```
 */
export function buildRegistry(
  adapters: Record<string, ProviderAdapter>,
): AdapterRegistry {
  return new Map(Object.entries(adapters));
}
