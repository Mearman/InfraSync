/**
 * Tests for provider hardening: convergence verification and rate limiting.
 *
 * Covers:
 * - Convergence verification retries on mismatch
 * - Convergence verification succeeds immediately on match
 * - Convergence verification fails after max retries
 * - Per-provider concurrency limits are respected via Semaphore
 * - Providers without maxConcurrency run fully parallel
 * - Cache TTL metadata (lastUpdated, isStale)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { executePhase, Semaphore } from "../execute-phase.js";
import type { ActionDag, ActionNode } from "../action-dag.js";
import type { ProviderPort, ResourcePort } from "../provider.js";
import { ResolvedScopes } from "../provider.js";
import { ResourceCache, MemoryCacheStore, type CacheStore } from "../cache.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

const testSpecSchema = z.strictObject({
  kind: z.literal("TestResource"),
  name: z.string().trim().min(1),
  value: z.string().trim().min(1),
});

const testStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    value: z.string().trim(),
  })
  .readonly();

function makeActionNode(
  overrides: Partial<ActionNode> &
    Pick<ActionNode, "id" | "action" | "resource" | "provider" | "kind">,
): ActionNode {
  const base: ActionNode = {
    spec: { kind: "TestResource", name: "test", value: "v1" },
    deps: [],
    id: overrides.id,
    action: overrides.action,
    resource: overrides.resource,
    provider: overrides.provider,
    kind: overrides.kind,
  };
  if (overrides.spec !== undefined) base.spec = overrides.spec;
  if (overrides.deps !== undefined) base.deps = [...overrides.deps];
  if (overrides.stateId !== undefined) base.stateId = overrides.stateId;
  if (overrides.diff !== undefined) base.diff = [...overrides.diff];
  return base;
}

function makeActionDag(actions: readonly ActionNode[]): ActionDag {
  return {
    actions: [...actions],
    planTimestamp: new Date().toISOString(),
    infraIRHash: "test-hash",
    stateMapHash: "test-hash",
  };
}

interface CallLogEntry {
  method: string;
  args: unknown[];
}

function makeResourcePort(options: {
  readResult?: unknown;
  createResult?: unknown;
  updateResult?: unknown;
  convergenceDelay?: number;
  callLog?: CallLogEntry[];
}): ResourcePort {
  const log = options.callLog ?? [];
  const createResult = options.createResult ?? {
    id: "created-1",
    name: "test",
    value: "v1",
  };

  const port: ResourcePort = {
    kind: "TestResource",
    specSchema: testSpecSchema,
    stateSchema: testStateSchema,
    identitySchema: testSpecSchema.pick({ name: true }),
    desiredStateSchema: testSpecSchema.pick({ name: true, value: true }),
    getStateId: (state: unknown) => {
      if (typeof state === "object" && state !== null && "id" in state) {
        const desc = Object.getOwnPropertyDescriptor(state, "id");
        if (desc !== undefined && typeof desc.value === "string") {
          return desc.value;
        }
      }
      return "default-id";
    },
    read: async (spec: unknown) => {
      log.push({ method: "read", args: [spec] });
      return options.readResult;
    },
    create: async (spec: unknown) => {
      log.push({ method: "create", args: [spec] });
      return createResult;
    },
    update: async (id: string, spec: unknown) => {
      log.push({ method: "update", args: [id, spec] });
      return options.updateResult ?? { id, name: "test", value: "v1" };
    },
  };

  // Only set convergenceDelay when it has a value — respects exactOptionalPropertyTypes
  if (options.convergenceDelay !== undefined) {
    Object.defineProperty(port, "convergenceDelay", {
      value: options.convergenceDelay,
      writable: false,
      enumerable: true,
      configurable: true,
    });
  }

  return port;
}

function makeProviderPort(options: {
  resourcePort: ResourcePort;
  maxConcurrency?: number;
}): ProviderPort {
  const provider: ProviderPort = {
    name: "test-provider",
    configSchema: z.strictObject({}),
    connect: async () => {
      /* mock — no-op */
    },
    disconnect: async () => {
      /* mock — no-op */
    },
    supportedKinds: () => ["TestResource"],
    resourceHandler: (_kind: string, _scopes?: ResolvedScopes) =>
      options.resourcePort,
  };

  if (options.maxConcurrency !== undefined) {
    Object.defineProperty(provider, "maxConcurrency", {
      value: options.maxConcurrency,
      writable: false,
      enumerable: true,
      configurable: true,
    });
  }

  return provider;
}

/** Safe array access — throws a descriptive error if the index is out of bounds. */
function mustAccess<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(
      `Index ${String(index)} out of bounds (length ${String(arr.length)})`,
    );
  }
  return value;
}

// ─── Semaphore tests ─────────────────────────────────────────────────────────

describe("Semaphore", () => {
  it("allows up to max concurrent acquisitions", async () => {
    const sem = new Semaphore(2);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();

    // Both acquired — should not block
    assert.ok(true, "Two concurrent acquisitions succeeded");

    release1();
    release2();
  });

  it("blocks when all slots are taken", async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    let acquired = false;
    const pending = sem.acquire().then((release) => {
      acquired = true;
      release();
    });

    // Give the event loop a chance to run
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(acquired, false, "Second acquire should be blocked");

    release1();
    await pending;
    assert.equal(
      acquired,
      true,
      "Second acquire should complete after release",
    );
  });

  it("processes queued waiters in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const release1 = await sem.acquire();
    order.push(1);

    const p2 = sem.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const p3 = sem.acquire().then((release) => {
      order.push(3);
      return release;
    });

    // Release first slot — should unblock p2
    release1();
    const release2 = await p2;

    // Release second slot — should unblock p3
    release2();
    const release3 = await p3;
    release3();

    assert.deepEqual(order, [1, 2, 3]);
  });

  it("throws RangeError for max < 1", () => {
    assert.throws(() => new Semaphore(0), RangeError);
    assert.throws(() => new Semaphore(-1), RangeError);
  });

  it("double-release is idempotent", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();

    release();
    release(); // Second release should be a no-op

    // Should still be able to acquire (only one active release counted)
    const release2 = await sem.acquire();
    release2();
  });
});

// ─── Convergence verification tests ──────────────────────────────────────────

describe("Convergence verification", () => {
  it("succeeds immediately when read-back matches expected state", async () => {
    const callLog: CallLogEntry[] = [];
    const expectedState = { id: "res-1", name: "test", value: "v1" };

    const resourcePort = makeResourcePort({
      readResult: expectedState,
      createResult: expectedState,
      convergenceDelay: 1, // 1ms — fast for tests
      callLog,
    });

    const provider = makeProviderPort({ resourcePort });
    const instances = new Map([["test-provider", provider]]);
    const configs = new Map([["test-provider", {}]]);

    const dag = makeActionDag([
      makeActionNode({
        id: "action-1",
        action: "create",
        resource: "test-res",
        provider: "test-provider",
        kind: "TestResource",
      }),
    ]);

    const result = await executePhase({
      actionDag: dag,
      instances,
      configs,
      dryRun: false,
    });

    assert.equal(result.result.issues.length, 0);
    assert.equal(result.result.resources.length, 1);
    const first = mustAccess(result.result.resources, 0);
    assert.equal(first.status, "success");

    // Should have: create call + one read-back verification call
    const creates = callLog.filter((l) => l.method === "create");
    const reads = callLog.filter((l) => l.method === "read");
    assert.equal(creates.length, 1, "Should call create once");
    assert.equal(reads.length, 1, "Should call read once for verification");
  });

  it("retries on mismatch and succeeds when state converges", async () => {
    const callLog: CallLogEntry[] = [];
    const expectedState = { id: "res-1", name: "test", value: "v1" };

    // read() returns mismatching state first, then matching state
    let readCallCount = 0;
    const resourcePort: ResourcePort = {
      kind: "TestResource",
      specSchema: testSpecSchema,
      stateSchema: testStateSchema,
      identitySchema: testSpecSchema.pick({ name: true }),
      desiredStateSchema: testSpecSchema.pick({ name: true, value: true }),
      convergenceDelay: 1,
      getStateId: () => "res-1",
      read: async (spec: unknown) => {
        callLog.push({ method: "read", args: [spec] });
        readCallCount++;
        if (readCallCount === 1) {
          // First read-back: wrong value
          return { id: "res-1", name: "test", value: "old-value" };
        }
        // Second read-back: matches expected
        return expectedState;
      },
      create: async (spec: unknown) => {
        callLog.push({ method: "create", args: [spec] });
        return expectedState;
      },
      update: async (id: string, spec: unknown) => {
        callLog.push({ method: "update", args: [id, spec] });
        return expectedState;
      },
    };

    const provider = makeProviderPort({ resourcePort });
    const instances = new Map([["test-provider", provider]]);
    const configs = new Map([["test-provider", {}]]);

    const dag = makeActionDag([
      makeActionNode({
        id: "action-1",
        action: "create",
        resource: "test-res",
        provider: "test-provider",
        kind: "TestResource",
      }),
    ]);

    const result = await executePhase({
      actionDag: dag,
      instances,
      configs,
      dryRun: false,
    });

    assert.equal(result.result.issues.length, 0);
    assert.equal(result.result.resources.length, 1);
    const first = mustAccess(result.result.resources, 0);
    assert.equal(first.status, "success");

    // create(1) + read for verification(2: mismatch then match)
    const reads = callLog.filter((l) => l.method === "read");
    assert.equal(reads.length, 2, "Should read twice: mismatch then match");
  });

  it("fails after max retries with an issue", async () => {
    const callLog: CallLogEntry[] = [];
    const expectedState = { id: "res-1", name: "test", value: "v1" };

    // read() always returns mismatching state
    const resourcePort: ResourcePort = {
      kind: "TestResource",
      specSchema: testSpecSchema,
      stateSchema: testStateSchema,
      identitySchema: testSpecSchema.pick({ name: true }),
      desiredStateSchema: testSpecSchema.pick({ name: true, value: true }),
      convergenceDelay: 1,
      getStateId: () => "res-1",
      read: async (spec: unknown) => {
        callLog.push({ method: "read", args: [spec] });
        return { id: "res-1", name: "test", value: "never-matching" };
      },
      create: async (spec: unknown) => {
        callLog.push({ method: "create", args: [spec] });
        return expectedState;
      },
      update: async (id: string, spec: unknown) => {
        callLog.push({ method: "update", args: [id, spec] });
        return expectedState;
      },
    };

    const provider = makeProviderPort({ resourcePort });
    const instances = new Map([["test-provider", provider]]);
    const configs = new Map([["test-provider", {}]]);

    const dag = makeActionDag([
      makeActionNode({
        id: "action-1",
        action: "create",
        resource: "test-res",
        provider: "test-provider",
        kind: "TestResource",
      }),
    ]);

    const result = await executePhase({
      actionDag: dag,
      instances,
      configs,
      dryRun: false,
    });

    assert.equal(result.result.resources.length, 1);
    const first = mustAccess(result.result.resources, 0);
    assert.equal(first.status, "failed");
    assert.equal(result.result.issues.length, 1);
    const issue = mustAccess(result.result.issues, 0);
    assert.ok(
      issue.message.includes("Convergence verification failed"),
      `Expected convergence failure message, got: ${issue.message}`,
    );

    // create(1) + read(3 attempts)
    const reads = callLog.filter((l) => l.method === "read");
    assert.equal(reads.length, 3, "Should read 3 times (max attempts)");
  });

  it("skips verification when convergenceDelay is undefined", async () => {
    const callLog: CallLogEntry[] = [];
    const expectedState = { id: "res-1", name: "test", value: "v1" };

    const resourcePort = makeResourcePort({
      readResult: expectedState,
      createResult: expectedState,
      // No convergenceDelay — no verification
      callLog,
    });

    const provider = makeProviderPort({ resourcePort });
    const instances = new Map([["test-provider", provider]]);
    const configs = new Map([["test-provider", {}]]);

    const dag = makeActionDag([
      makeActionNode({
        id: "action-1",
        action: "create",
        resource: "test-res",
        provider: "test-provider",
        kind: "TestResource",
      }),
    ]);

    const result = await executePhase({
      actionDag: dag,
      instances,
      configs,
      dryRun: false,
    });

    assert.equal(result.result.issues.length, 0);
    const first = mustAccess(result.result.resources, 0);
    assert.equal(first.status, "success");

    // Only create call — no read-back verification
    const reads = callLog.filter((l) => l.method === "read");
    assert.equal(
      reads.length,
      0,
      "Should not call read when no convergenceDelay",
    );
  });
});

// ─── Per-provider concurrency tests ──────────────────────────────────────────

describe("Per-provider concurrency limits", () => {
  it("respects maxConcurrency for a single provider", async () => {
    const maxConcurrent = { current: 0, peak: 0 };
    const expectedState = { id: "res-1", name: "test", value: "v1" };

    // Create a resource that tracks concurrent calls
    const resourcePort: ResourcePort = {
      kind: "TestResource",
      specSchema: testSpecSchema,
      stateSchema: testStateSchema,
      identitySchema: testSpecSchema.pick({ name: true }),
      desiredStateSchema: testSpecSchema.pick({ name: true, value: true }),
      getStateId: () => "res-1",
      read: async () => expectedState,
      create: async (_spec: unknown) => {
        maxConcurrent.current++;
        if (maxConcurrent.current > maxConcurrent.peak) {
          maxConcurrent.peak = maxConcurrent.current;
        }
        // Simulate some async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        maxConcurrent.current--;
        return expectedState;
      },
      update: async () => expectedState,
    };

    const provider = makeProviderPort({
      resourcePort,
      maxConcurrency: 2,
    });

    const instances = new Map([["test-provider", provider]]);
    const configs = new Map([["test-provider", {}]]);

    // Create 5 actions that should be limited to 2 concurrent
    const dag = makeActionDag(
      Array.from({ length: 5 }, (_, i) =>
        makeActionNode({
          id: `action-${String(i)}`,
          action: "create",
          resource: `res-${String(i)}`,
          provider: "test-provider",
          kind: "TestResource",
          spec: {
            kind: "TestResource",
            name: `res-${String(i)}`,
            value: "v1",
          },
        }),
      ),
    );

    const result = await executePhase({
      actionDag: dag,
      instances,
      configs,
      dryRun: false,
    });

    assert.equal(result.result.issues.length, 0);
    assert.equal(result.result.resources.length, 5);
    for (const resource of result.result.resources) {
      assert.equal(resource.status, "success");
    }

    // Peak concurrency should not exceed maxConcurrency
    assert.equal(
      maxConcurrent.peak,
      2,
      `Peak concurrency should be 2, got ${String(maxConcurrent.peak)}`,
    );
  });

  it("runs providers without maxConcurrency fully parallel", async () => {
    const maxConcurrent = { current: 0, peak: 0 };
    const expectedState = { id: "res-1", name: "test", value: "v1" };

    const resourcePort: ResourcePort = {
      kind: "TestResource",
      specSchema: testSpecSchema,
      stateSchema: testStateSchema,
      identitySchema: testSpecSchema.pick({ name: true }),
      desiredStateSchema: testSpecSchema.pick({ name: true, value: true }),
      getStateId: () => "res-1",
      read: async () => expectedState,
      create: async () => {
        maxConcurrent.current++;
        if (maxConcurrent.current > maxConcurrent.peak) {
          maxConcurrent.peak = maxConcurrent.current;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        maxConcurrent.current--;
        return expectedState;
      },
      update: async () => expectedState,
    };

    // No maxConcurrency — should run all in parallel
    const provider = makeProviderPort({ resourcePort });
    const instances = new Map([["test-provider", provider]]);
    const configs = new Map([["test-provider", {}]]);

    const dag = makeActionDag(
      Array.from({ length: 10 }, (_, i) =>
        makeActionNode({
          id: `action-${String(i)}`,
          action: "create",
          resource: `res-${String(i)}`,
          provider: "test-provider",
          kind: "TestResource",
          spec: {
            kind: "TestResource",
            name: `res-${String(i)}`,
            value: "v1",
          },
        }),
      ),
    );

    const result = await executePhase({
      actionDag: dag,
      instances,
      configs,
      dryRun: false,
    });

    assert.equal(result.result.issues.length, 0);
    assert.equal(result.result.resources.length, 10);

    // All 10 should have been concurrent
    assert.equal(
      maxConcurrent.peak,
      10,
      `Peak concurrency should be 10 (unlimited), got ${String(maxConcurrent.peak)}`,
    );
  });

  it("runs different provider groups concurrently", async () => {
    const executionOrder: { provider: string; time: number }[] = [];

    const expectedState = { id: "res-1", name: "test", value: "v1" };

    function makeProvider(
      name: string,
      maxConcurrency: number | undefined,
    ): ProviderPort {
      const resourcePort: ResourcePort = {
        kind: "TestResource",
        specSchema: testSpecSchema,
        stateSchema: testStateSchema,
        identitySchema: testSpecSchema.pick({ name: true }),
        desiredStateSchema: testSpecSchema.pick({ name: true, value: true }),
        getStateId: () => "res-1",
        read: async () => expectedState,
        create: async () => {
          executionOrder.push({ provider: name, time: Date.now() });
          await new Promise((resolve) => setTimeout(resolve, 20));
          return expectedState;
        },
        update: async () => expectedState,
      };

      const prov: ProviderPort = {
        name,
        configSchema: z.strictObject({}),
        connect: async () => {
          /* mock — no-op */
        },
        disconnect: async () => {
          /* mock — no-op */
        },
        supportedKinds: () => ["TestResource"],
        resourceHandler: () => resourcePort,
      };

      if (maxConcurrency !== undefined) {
        Object.defineProperty(prov, "maxConcurrency", {
          value: maxConcurrency,
          writable: false,
          enumerable: true,
          configurable: true,
        });
      }

      return prov;
    }

    const providerA = makeProvider("provider-a", undefined);
    const providerB = makeProvider("provider-b", undefined);
    const instances = new Map([
      ["provider-a", providerA],
      ["provider-b", providerB],
    ]);
    const configs = new Map([
      ["provider-a", {}],
      ["provider-b", {}],
    ]);

    // Both actions are at the same DAG level
    const dag = makeActionDag([
      makeActionNode({
        id: "action-1",
        action: "create",
        resource: "res-a",
        provider: "provider-a",
        kind: "TestResource",
        spec: { kind: "TestResource", name: "res-a", value: "v1" },
      }),
      makeActionNode({
        id: "action-2",
        action: "create",
        resource: "res-b",
        provider: "provider-b",
        kind: "TestResource",
        spec: { kind: "TestResource", name: "res-b", value: "v1" },
      }),
    ]);

    const result = await executePhase({
      actionDag: dag,
      instances,
      configs,
      dryRun: false,
    });

    assert.equal(result.result.issues.length, 0);
    assert.equal(result.result.resources.length, 2);

    // Both should have started within 10ms of each other (concurrent)
    assert.equal(executionOrder.length, 2);
    const first = mustAccess(executionOrder, 0);
    const second = mustAccess(executionOrder, 1);
    const timeDiff = Math.abs(first.time - second.time);
    assert.ok(
      timeDiff < 10,
      `Provider groups should run concurrently (time diff: ${String(timeDiff)}ms)`,
    );
  });
});

// ─── Cache TTL metadata tests ────────────────────────────────────────────────

describe("Cache TTL metadata", () => {
  function createStore(): CacheStore {
    return new MemoryCacheStore();
  }

  it("records lastUpdated timestamp on set", () => {
    const store = createStore();
    const cache = new ResourceCache({ store, defaultTtl: 60_000 });
    const before = new Date();

    cache.set("key1", { id: "abc" });

    const after = new Date();
    const entry = cache.getEntry("key1");
    assert.ok(entry !== undefined, "Entry should exist");

    const lastUpdated = Date.parse(entry.lastUpdated);
    assert.ok(
      lastUpdated >= before.getTime() && lastUpdated <= after.getTime(),
      "lastUpdated should be between set() call start and end",
    );
  });

  it("getEntry returns undefined for missing keys", () => {
    const store = createStore();
    const cache = new ResourceCache({ store, defaultTtl: 60_000 });
    assert.equal(cache.getEntry("nonexistent"), undefined);
  });

  it("getEntry returns undefined for expired entries", () => {
    const store = createStore();
    const cache = new ResourceCache({ store, defaultTtl: 1 });
    cache.set("key1", { id: "abc" });

    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait
    }

    assert.equal(cache.getEntry("key1"), undefined);
  });

  it("isStale returns undefined for missing entries", () => {
    const store = createStore();
    const cache = new ResourceCache({ store, defaultTtl: 60_000 });
    assert.equal(cache.isStale("nonexistent", 1_000), undefined);
  });

  it("isStale returns false for fresh entries", () => {
    const store = createStore();
    const cache = new ResourceCache({ store, defaultTtl: 60_000 });
    cache.set("key1", { id: "abc" });
    assert.equal(cache.isStale("key1", 10_000), false);
  });

  it("isStale returns true for stale but not expired entries", () => {
    const store = createStore();
    const cache = new ResourceCache({ store, defaultTtl: 10_000 }); // 10s expiry
    cache.set("key1", { id: "abc" });

    // Wait for the entry to age past the maxAge threshold
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait 5ms
    }

    // maxAge of 1ms — entry should now be stale
    assert.equal(cache.isStale("key1", 1), true);
  });

  it("get still returns state for backward compatibility", () => {
    const store = createStore();
    const cache = new ResourceCache({ store, defaultTtl: 60_000 });
    cache.set("key1", { id: "abc", name: "test" });

    const result = cache.get("key1");
    assert.deepEqual(result, { id: "abc", name: "test" });
  });
});
