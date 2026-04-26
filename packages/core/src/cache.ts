import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as z from "zod";
import { ResolvedScopes } from "./provider.js";
import type { ProviderPort, ResourcePort } from "./provider.js";

// ─── CacheStore interface ────────────────────────────────────────────────────

/**
 * A pluggable key-value store for cache entries.
 *
 * Stores opaque strings — the caller (ResourceCache) handles serialisation
 * and TTL logic. Implementations choose their own storage backend:
 *
 * - `FileCacheStore` — `.infrasync/cache/*.json` files on disk
 * - `MemoryCacheStore` — `Map<string, string>` in-process
 * - Custom: Redis, S3, SQLite, etc.
 *
 * Values are JSON-serialised cache entries. Stores never parse them —
 * they just hold and retrieve opaque strings.
 */
export interface CacheStore {
  /** Retrieve a value by key. Returns undefined if not found. */
  get(key: string): string | undefined;

  /** Store a value under the given key. Overwrites if present. */
  set(key: string, value: string): void;

  /** Delete a specific key. No-op if the key doesn't exist. */
  delete(key: string): void;

  /** Remove all entries. Returns the number of entries cleared. */
  clear(): number;

  /** Count of entries currently in the store. */
  size(): number;
}

// ─── FileCacheStore ──────────────────────────────────────────────────────────

/**
 * Filesystem-backed cache store.
 *
 * Stores one JSON file per entry in the configured directory.
 * Keys are used directly as filenames (they're SHA-256 hex digests
 * so filesystem-safe). Files contain the raw value string as-is.
 */
export class FileCacheStore implements CacheStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? path.join(process.cwd(), ".infrasync", "cache");
  }

  get(key: string): string | undefined {
    const filePath = this.path(key);
    if (!fs.existsSync(filePath)) return undefined;
    return fs.readFileSync(filePath, "utf-8");
  }

  set(key: string, value: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const filePath = this.path(key);

    // Write atomically via temp file + rename
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, value);
    fs.renameSync(tmpPath, filePath);
  }

  delete(key: string): void {
    const filePath = this.path(key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  clear(): number {
    if (!fs.existsSync(this.dir)) return 0;

    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      fs.unlinkSync(path.join(this.dir, file));
    }
    return files.length;
  }

  size(): number {
    if (!fs.existsSync(this.dir)) return 0;
    return fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).length;
  }

  private path(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }
}

// ─── MemoryCacheStore ────────────────────────────────────────────────────────

/**
 * In-memory cache store.
 *
 * Stores entries in a `Map<string, string>`. Dies with the process.
 * Useful for single-run CI pipelines or tests where persistence
 * across runs isn't needed but repeated API calls within a single
 * execution should be avoided.
 */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, string>();

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): number {
    const count = this.entries.size;
    this.entries.clear();
    return count;
  }

  size(): number {
    return this.entries.size;
  }
}

// ─── Cache entry schema ──────────────────────────────────────────────────────

const cacheEntrySchema = z.object({
  /** ISO-8601 timestamp when this entry expires */
  expiresAt: z.string().trim(),
  /** The cached state value */
  state: z.unknown(),
});

// ─── Cache key derivation ────────────────────────────────────────────────────

/**
 * Derive a deterministic cache key from provider identity, resource kind,
 * scopes, and identity fields.
 *
 * The key is a SHA-256 hex digest of a canonical JSON representation,
 * ensuring the same inputs always produce the same key regardless of
 * object property order.
 */
function deriveCacheKey(
  providerName: string,
  kind: string,
  scopes: ResolvedScopes,
  spec: unknown,
): string {
  const keyMaterial = {
    provider: providerName,
    kind,
    // Scopes are part of the key because the same resource name
    // in different accounts/zones is a different resource.
    scopes: scopes,
    identity: spec,
  };
  // Sort top-level keys for deterministic ordering.
  const sorted = Object.fromEntries(
    Object.entries(keyMaterial).sort(([a], [b]) => a.localeCompare(b)),
  );
  const serialised = JSON.stringify(sorted);
  return crypto.createHash("sha256").update(serialised).digest("hex");
}

// ─── ResourceCache ───────────────────────────────────────────────────────────

/** Configuration for the resource cache. */
export interface CacheConfig {
  /** Store backend. Default: FileCacheStore */
  readonly store?: CacheStore;
  /** Directory for FileCacheStore (ignored if store is provided). Default: ".infrasync/cache" */
  readonly dir?: string;
  /** Default TTL in milliseconds. Default: 300_000 (5 minutes) */
  readonly defaultTtl?: number;
}

/**
 * Cache layer for provider resource state.
 *
 * Handles TTL logic and serialisation on top of a pluggable `CacheStore`.
 * The store holds opaque strings; this layer wraps them with expiry metadata.
 *
 * The cache is a performance optimisation only. Clearing the store
 * causes no data loss — InfraSync re-queries providers transparently.
 */
export class ResourceCache {
  private readonly store: CacheStore;
  private readonly defaultTtl: number;

  constructor(config?: CacheConfig) {
    this.store = config?.store ?? new FileCacheStore(config?.dir);
    this.defaultTtl = config?.defaultTtl ?? 300_000;
  }

  /**
   * Look up a cached state entry.
   * Returns undefined if the entry doesn't exist, is corrupted, or has expired.
   */
  get(key: string): unknown {
    const raw = this.store.get(key);
    if (raw === undefined) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted entry — remove and return miss
      this.store.delete(key);
      return undefined;
    }

    const result = cacheEntrySchema.safeParse(parsed);
    if (!result.success) {
      this.store.delete(key);
      return undefined;
    }

    const { expiresAt, state } = result.data;
    if (Date.now() > Date.parse(expiresAt)) {
      this.store.delete(key);
      return undefined;
    }

    return state;
  }

  /**
   * Store a state entry with an optional TTL override.
   */
  set(key: string, state: unknown, ttl?: number): void {
    const expiresAt = new Date(Date.now() + (ttl ?? this.defaultTtl));
    const entry = { expiresAt: expiresAt.toISOString(), state };
    this.store.set(key, JSON.stringify(entry));
  }

  /**
   * Invalidate a specific cache entry.
   */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /**
   * Clear all cache entries.
   */
  clear(): number {
    return this.store.clear();
  }

  /**
   * Get the number of entries in the underlying store.
   */
  size(): number {
    return this.store.size();
  }

  /** Expose key derivation for CachedProviderPort */
  static deriveCacheKey = deriveCacheKey;

  /** Expose the underlying store for consumers that need direct access */
  get storeBackend(): CacheStore {
    return this.store;
  }
}

// ─── CachedProviderPort ──────────────────────────────────────────────────────

/**
 * Decorator that wraps a ProviderPort with caching on read operations.
 *
 * - `read()` checks the cache first; on miss, calls the real handler
 *   and caches the result.
 * - `create()` and `update()` invalidate the cache entry for that resource.
 * - All other methods delegate to the wrapped provider.
 *
 * Usage:
 *
 * ```typescript
 * const cached = new CachedProviderPort(realProvider, cache, { ttl: 300_000 });
 * ```
 */
export class CachedProviderPort implements ProviderPort {
  readonly name: string;
  readonly configSchema;

  private readonly inner: ProviderPort;
  private readonly cache: ResourceCache;
  private readonly ttl: number;

  constructor(
    inner: ProviderPort,
    cache: ResourceCache,
    options?: { readonly ttl?: number },
  ) {
    this.inner = inner;
    this.cache = cache;
    this.name = inner.name;
    this.configSchema = inner.configSchema;
    this.ttl = options?.ttl ?? 300_000;
  }

  async connect(config: unknown): Promise<void> {
    await this.inner.connect(config);
  }

  async disconnect(): Promise<void> {
    await this.inner.disconnect();
  }

  supportedKinds(): string[] {
    return this.inner.supportedKinds();
  }

  resourceHandler(kind: string, scopes?: ResolvedScopes): ResourcePort {
    const resolvedScopes = scopes ?? ResolvedScopes.empty;
    const innerHandler = this.inner.resourceHandler(kind, resolvedScopes);

    const port = createCachedResourcePort(innerHandler, this.cache, {
      providerName: this.name,
      kind,
      resolvedScopes,
      ttl: this.ttl,
    });

    return port;
  }
}

// ─── CachedResourcePort (factory) ────────────────────────────────────────────

/**
 * Create a cached wrapper around a ResourcePort.
 *
 * Returns a plain object satisfying the ResourcePort interface structurally.
 * Uses a factory function instead of a class to avoid exactOptionalPropertyTypes
 * friction with optional interface properties (codec?, scopes?).
 */
function createCachedResourcePort(
  inner: ResourcePort,
  cache: ResourceCache,
  options: {
    readonly providerName: string;
    readonly kind: string;
    readonly resolvedScopes: ResolvedScopes;
    readonly ttl: number;
  },
): ResourcePort {
  const { providerName, kind: resourceKind, resolvedScopes, ttl } = options;

  function deriveKey(spec: unknown): string {
    return ResourceCache.deriveCacheKey(
      providerName,
      resourceKind,
      resolvedScopes,
      spec,
    );
  }

  function invalidateFor(spec: unknown): void {
    cache.invalidate(deriveKey(spec));
  }

  const result: ResourcePort = {
    kind: inner.kind,
    specSchema: inner.specSchema,
    stateSchema: inner.stateSchema,
    identitySchema: inner.identitySchema,
    desiredStateSchema: inner.desiredStateSchema,
    getStateId: inner.getStateId.bind(inner),
    read: async (spec: unknown) => {
      const key = deriveKey(spec);

      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      const state = await inner.read(spec);

      // Only cache non-undefined results.
      // undefined means "resource doesn't exist" — caching that would
      // prevent detecting newly-created resources within the TTL window.
      if (state !== undefined) cache.set(key, state, ttl);

      return state;
    },
    create: async (spec: unknown) => {
      const state = await inner.create(spec);
      invalidateFor(spec);
      return state;
    },
    update: async (id: string, spec: unknown) => {
      const state = await inner.update(id, spec);
      invalidateFor(spec);
      return state;
    },
  };

  // Propagate optional properties from inner handler via spread
  return {
    ...result,
    ...(inner.codec !== undefined ? { codec: inner.codec } : {}),
    ...(inner.scopes !== undefined ? { scopes: inner.scopes } : {}),
  };
}
