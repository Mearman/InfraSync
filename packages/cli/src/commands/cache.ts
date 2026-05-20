/**
 * CLI commands for managing the resource cache.
 *
 * `infrasync cache status` — show cache statistics
 * `infrasync cache clear`  — remove all cached entries
 */
import { ResourceCache, FileCacheStore } from "@infrasync-org/core/cache";

function createDefaultCache(): ResourceCache {
  return new ResourceCache({
    store: new FileCacheStore(),
  });
}

export function cacheStatus(): void {
  const cache = createDefaultCache();
  const count = cache.size();
  console.log(`Cache entries: ${String(count)}`);
}

export function cacheClear(): void {
  const cache = createDefaultCache();
  const count = cache.clear();
  console.log(`Cleared ${String(count)} cache entries.`);
}
