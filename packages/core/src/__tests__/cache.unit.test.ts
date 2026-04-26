import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as z from "zod";
import {
  ResourceCache,
  CachedProviderPort,
  FileCacheStore,
  MemoryCacheStore,
  type CacheStore,
} from "../cache.js";
import {
  ResolvedScopes,
  type ProviderPort,
  type ResourcePort,
} from "../provider.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infrasync-cache-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCache(store: CacheStore, ttl = 60_000): ResourceCache {
  return new ResourceCache({ store, defaultTtl: ttl });
}

// ─── FileCacheStore ──────────────────────────────────────────────────────────

describe("FileCacheStore", () => {
  it("returns undefined for missing keys", () => {
    const store = new FileCacheStore(tmpDir);
    assert.equal(store.get("missing"), undefined);
  });

  it("stores and retrieves string values", () => {
    const store = new FileCacheStore(tmpDir);
    store.set("key1", "hello");
    assert.equal(store.get("key1"), "hello");
  });

  it("overwrites existing values", () => {
    const store = new FileCacheStore(tmpDir);
    store.set("key1", "first");
    store.set("key1", "second");
    assert.equal(store.get("key1"), "second");
  });

  it("deletes entries", () => {
    const store = new FileCacheStore(tmpDir);
    store.set("key1", "value");
    store.delete("key1");
    assert.equal(store.get("key1"), undefined);
  });

  it("clears all entries and returns count", () => {
    const store = new FileCacheStore(tmpDir);
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");
    assert.equal(store.clear(), 3);
    assert.equal(store.size(), 0);
  });

  it("returns 0 from clear when empty", () => {
    const store = new FileCacheStore(tmpDir);
    assert.equal(store.clear(), 0);
  });

  it("reports size", () => {
    const store = new FileCacheStore(tmpDir);
    store.set("a", "1");
    store.set("b", "2");
    assert.equal(store.size(), 2);
  });

  it("delete is no-op for missing keys", () => {
    const store = new FileCacheStore(tmpDir);
    store.delete("nonexistent"); // should not throw
  });
});

// ─── MemoryCacheStore ────────────────────────────────────────────────────────

describe("MemoryCacheStore", () => {
  it("returns undefined for missing keys", () => {
    const store = new MemoryCacheStore();
    assert.equal(store.get("missing"), undefined);
  });

  it("stores and retrieves string values", () => {
    const store = new MemoryCacheStore();
    store.set("key1", "hello");
    assert.equal(store.get("key1"), "hello");
  });

  it("overwrites existing values", () => {
    const store = new MemoryCacheStore();
    store.set("key1", "first");
    store.set("key1", "second");
    assert.equal(store.get("key1"), "second");
  });

  it("deletes entries", () => {
    const store = new MemoryCacheStore();
    store.set("key1", "value");
    store.delete("key1");
    assert.equal(store.get("key1"), undefined);
  });

  it("clears all entries and returns count", () => {
    const store = new MemoryCacheStore();
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");
    assert.equal(store.clear(), 3);
    assert.equal(store.size(), 0);
  });

  it("returns 0 from clear when empty", () => {
    const store = new MemoryCacheStore();
    assert.equal(store.clear(), 0);
  });

  it("reports size", () => {
    const store = new MemoryCacheStore();
    store.set("a", "1");
    store.set("b", "2");
    assert.equal(store.size(), 2);
  });

  it("delete is no-op for missing keys", () => {
    const store = new MemoryCacheStore();
    store.delete("nonexistent"); // should not throw
  });
});

// ─── ResourceCache (store-agnostic tests) ────────────────────────────────────

/**
 * Run the same ResourceCache test suite against both FileCacheStore
 * and MemoryCacheStore to prove the policy layer is store-independent.
 */
function resourceCacheTests(name: string, createStore: () => CacheStore): void {
  describe(`ResourceCache (${name})`, () => {
    it("returns undefined for missing keys", () => {
      const cache = makeCache(createStore());
      assert.equal(cache.get("nonexistent"), undefined);
    });

    it("stores and retrieves values", () => {
      const cache = makeCache(createStore());
      cache.set("key1", { id: "abc", name: "test" });
      const result = cache.get("key1");
      assert.deepEqual(result, { id: "abc", name: "test" });
    });

    it("expires entries after TTL", () => {
      // 1ms TTL — will expire immediately
      const cache = makeCache(createStore(), 1);
      cache.set("key1", { id: "abc" });

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy-wait 5ms
      }

      assert.equal(cache.get("key1"), undefined);
    });

    it("removes expired entries from store on get", () => {
      const store = createStore();
      const cache = makeCache(store, 1);
      cache.set("key1", { id: "abc" });

      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy-wait
      }

      cache.get("key1");
      assert.equal(store.size(), 0);
    });

    it("invalidates specific keys", () => {
      const cache = makeCache(createStore());
      cache.set("key1", { id: "abc" });
      cache.set("key2", { id: "def" });

      cache.invalidate("key1");

      assert.equal(cache.get("key1"), undefined);
      assert.deepEqual(cache.get("key2"), { id: "def" });
    });

    it("clears all entries", () => {
      const cache = makeCache(createStore());
      cache.set("key1", { id: "abc" });
      cache.set("key2", { id: "def" });
      cache.set("key3", { id: "ghi" });

      const count = cache.clear();
      assert.equal(count, 3);
      assert.equal(cache.get("key1"), undefined);
      assert.equal(cache.get("key2"), undefined);
      assert.equal(cache.get("key3"), undefined);
    });

    it("reports size", () => {
      const cache = makeCache(createStore());
      cache.set("key1", { id: "abc" });
      cache.set("key2", { id: "def" });
      assert.equal(cache.size(), 2);
    });

    it("derives deterministic keys", () => {
      const key1 = ResourceCache.deriveCacheKey(
        "cloudflare",
        "DnsRecord",
        ResolvedScopes.empty,
        { name: "example.com", type: "CNAME" },
      );
      const key2 = ResourceCache.deriveCacheKey(
        "cloudflare",
        "DnsRecord",
        ResolvedScopes.empty,
        { name: "example.com", type: "CNAME" },
      );
      assert.equal(key1, key2);
    });

    it("derives different keys for different specs", () => {
      const key1 = ResourceCache.deriveCacheKey(
        "cloudflare",
        "DnsRecord",
        ResolvedScopes.empty,
        { name: "a.example.com", type: "CNAME" },
      );
      const key2 = ResourceCache.deriveCacheKey(
        "cloudflare",
        "DnsRecord",
        ResolvedScopes.empty,
        { name: "b.example.com", type: "CNAME" },
      );
      assert.notEqual(key1, key2);
    });

    it("derives different keys for different providers", () => {
      const key1 = ResourceCache.deriveCacheKey(
        "cloudflare",
        "DnsRecord",
        ResolvedScopes.empty,
        { name: "example.com" },
      );
      const key2 = ResourceCache.deriveCacheKey(
        "aws",
        "DnsRecord",
        ResolvedScopes.empty,
        { name: "example.com" },
      );
      assert.notEqual(key1, key2);
    });

    it("survives corrupted store values", () => {
      const store = createStore();
      // Write garbage directly to the store
      store.set("bad-key", "not json{{{");
      const cache = new ResourceCache({ store, defaultTtl: 60_000 });
      assert.equal(cache.get("bad-key"), undefined);
      // Corrupted entry should be removed
      assert.equal(store.get("bad-key"), undefined);
    });

    it("survives entries with invalid schema", () => {
      const store = createStore();
      store.set("bad-schema", JSON.stringify({ wrong: "shape" }));
      const cache = new ResourceCache({ store, defaultTtl: 60_000 });
      assert.equal(cache.get("bad-schema"), undefined);
      assert.equal(store.get("bad-schema"), undefined);
    });
  });
}

resourceCacheTests("FileCacheStore", () => new FileCacheStore(tmpDir));
resourceCacheTests("MemoryCacheStore", () => new MemoryCacheStore());

// ─── CachedProviderPort ──────────────────────────────────────────────────────

describe("CachedProviderPort", () => {
  const testSpecSchema = z.object({
    kind: z.literal("TestResource"),
    name: z.string().trim(),
  });

  const testStateSchema = z
    .looseObject({ id: z.string().trim(), name: z.string().trim() })
    .readonly();

  function createMockProvider(readResult: unknown): {
    provider: ProviderPort;
    getReadCalls: () => number;
  } {
    let readCalls = 0;

    const mockHandler: ResourcePort = {
      kind: "TestResource",
      specSchema: testSpecSchema,
      stateSchema: testStateSchema,
      identitySchema: testSpecSchema.pick({ name: true }),
      desiredStateSchema: testSpecSchema.pick({ name: true }),
      getStateId: (state: unknown) => {
        if (typeof state === "object" && state !== null && "id" in state) {
          const desc = Object.getOwnPropertyDescriptor(state, "id");
          if (desc !== undefined && typeof desc.value === "string") {
            return desc.value;
          }
        }
        return "";
      },
      read: async () => {
        readCalls++;
        return readResult;
      },
      create: async () => ({ id: "new-id", name: "created" }),
      update: async () => ({ id: "updated-id", name: "updated" }),
    };

    const mockProvider: ProviderPort = {
      name: "test-provider",
      configSchema: z.object({}),
      connect: async () => {
        /* mock — no-op */
      },
      disconnect: async () => {
        /* mock — no-op */
      },
      supportedKinds: () => ["TestResource"],
      resourceHandler: (_kind: string, _scopes?: ResolvedScopes) => mockHandler,
    };

    return { provider: mockProvider, getReadCalls: () => readCalls };
  }

  it("caches read results", async () => {
    const { provider, getReadCalls } = createMockProvider({
      id: "res-1",
      name: "test",
    });
    const cache = new ResourceCache({ store: new MemoryCacheStore() });
    const cached = new CachedProviderPort(provider, cache);

    await cached.connect({});
    const handler = cached.resourceHandler("TestResource");

    const result1 = await handler.read({ kind: "TestResource", name: "test" });
    assert.equal(getReadCalls(), 1);
    assert.deepEqual(result1, { id: "res-1", name: "test" });

    const result2 = await handler.read({ kind: "TestResource", name: "test" });
    assert.equal(getReadCalls(), 1);
    assert.deepEqual(result2, { id: "res-1", name: "test" });

    await cached.disconnect();
  });

  it("does not cache undefined results", async () => {
    const { provider, getReadCalls } = createMockProvider(undefined);
    const cache = new ResourceCache({ store: new MemoryCacheStore() });
    const cached = new CachedProviderPort(provider, cache);

    await cached.connect({});
    const handler = cached.resourceHandler("TestResource");

    await handler.read({ kind: "TestResource", name: "missing" });
    assert.equal(getReadCalls(), 1);

    await handler.read({ kind: "TestResource", name: "missing" });
    assert.equal(getReadCalls(), 2);

    await cached.disconnect();
  });

  it("invalidates cache after create", async () => {
    const { provider, getReadCalls } = createMockProvider({
      id: "res-1",
      name: "test",
    });
    const cache = new ResourceCache({ store: new MemoryCacheStore() });
    const cached = new CachedProviderPort(provider, cache);

    await cached.connect({});
    const handler = cached.resourceHandler("TestResource");

    await handler.read({ kind: "TestResource", name: "test" });
    assert.equal(getReadCalls(), 1);

    await handler.create({ kind: "TestResource", name: "test" });

    await handler.read({ kind: "TestResource", name: "test" });
    assert.equal(getReadCalls(), 2);

    await cached.disconnect();
  });

  it("invalidates cache after update", async () => {
    const { provider, getReadCalls } = createMockProvider({
      id: "res-1",
      name: "test",
    });
    const cache = new ResourceCache({ store: new MemoryCacheStore() });
    const cached = new CachedProviderPort(provider, cache);

    await cached.connect({});
    const handler = cached.resourceHandler("TestResource");

    await handler.read({ kind: "TestResource", name: "test" });
    assert.equal(getReadCalls(), 1);

    await handler.update("res-1", { kind: "TestResource", name: "test" });

    await handler.read({ kind: "TestResource", name: "test" });
    assert.equal(getReadCalls(), 2);

    await cached.disconnect();
  });

  it("passes through provider lifecycle", async () => {
    const { provider } = createMockProvider({ id: "res-1", name: "test" });
    const cache = new ResourceCache({ store: new MemoryCacheStore() });
    const cached = new CachedProviderPort(provider, cache);

    await cached.connect({});
    assert.deepEqual(cached.supportedKinds(), ["TestResource"]);
    await cached.disconnect();
  });

  it("propagates codec and scopes from inner handler", () => {
    const { provider } = createMockProvider({ id: "res-1", name: "test" });
    const cache = new ResourceCache({ store: new MemoryCacheStore() });
    const cached = new CachedProviderPort(provider, cache);

    const handler = cached.resourceHandler("TestResource");
    assert.equal(handler.codec, undefined);
    assert.equal(handler.scopes, undefined);
  });
});
