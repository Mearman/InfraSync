/**
 * End-to-end integration test exercising the full InfraSync pipeline:
 *
 * defineInfra → compileToIR → SyncEngine → plan → apply
 * with cache, scopes, codecs, convergence, and ref resolution.
 *
 * Uses a scoped mock provider to avoid real API calls.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { defineInfra } from "../compiler.js";
import { defineProvider, ResolvedScopes } from "../provider.js";
import type {
  ProviderPort,
  ResourcePort,
  ResourceScopes,
  ResourceCodec,
} from "../provider.js";
import { SyncEngine } from "../sync.js";
import { ResourceCache, MemoryCacheStore, TieredCacheStore } from "../cache.js";
import { RefToken } from "../refs.js";

// ─── Scoped mock provider ────────────────────────────────────────────────────

/**
 * A scoped resource that belongs to an "account" (like Cloudflare).
 * Tests scope resolution, codec mapping, and convergence checking.
 */
const widgetSpecSchema = z.object({
  kind: z.literal("Widget"),
  name: z.string().trim().min(1),
  /** Desired label — camelCase in spec, snake_case in provider state */
  label: z.string().trim().optional(),
  /** Ref to another resource's ID — tests ref resolution */
  parentId: z.string().trim().optional(),
});

const resolvedSpecSchema = z.object({
  kind: z.literal("Widget"),
  name: z.string().trim().min(1),
  label: z.string().trim().optional(),
  parentId: z.string().trim().optional(),
});

const widgetStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    /** Provider stores label as snake_case */
    label_text: z.string().trim().optional(),
    parent_id: z.string().trim().optional(),
    account_id: z.string().trim().optional(),
  })
  .readonly();

const widgetIdentitySchema = widgetSpecSchema.pick({ name: true });
const widgetDesiredStateSchema = widgetSpecSchema.pick({ label: true });

// ─── Codec: camelCase ↔ snake_case ──────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("Widget"),
  name: z.string().trim().min(1),
  label: z.string().trim().optional(),
});

const codecOutputSchema = z.looseObject({
  label_text: z.string().trim().optional(),
});

const widgetZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    label_text: spec.label,
  }),
  encode: (state) => ({
    kind: "Widget" as const,
    name: "placeholder",
    label: state.label_text,
  }),
});

const widgetCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return widgetZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return widgetZodCodec.decode(result.data);
  },
};

// ─── In-memory store ─────────────────────────────────────────────────────────

interface WidgetEntry {
  id: string;
  name: string;
  accountId: string;
  labelText: string;
  parentId: string;
}

// ─── Scoped widget handler ──────────────────────────────────────────────────

class WidgetResourceHandler implements ResourcePort {
  readonly kind = "Widget" as const;
  readonly specSchema = widgetSpecSchema;
  readonly stateSchema = widgetStateSchema;
  readonly identitySchema = widgetIdentitySchema;
  readonly desiredStateSchema = widgetDesiredStateSchema;
  readonly codec = widgetCodec;

  readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  private readonly store: Map<string, WidgetEntry>;
  private readonly readCounts: { value: number };
  private readonly resolvedScopes: ResolvedScopes;

  constructor(
    store: Map<string, WidgetEntry>,
    readCounts: { value: number },
    scopes: ResolvedScopes,
  ) {
    this.store = store;
    this.readCounts = readCounts;
    this.resolvedScopes = scopes;
  }

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      const desc = Object.getOwnPropertyDescriptor(state, "id");
      if (desc !== undefined && typeof desc.value === "string") {
        return desc.value;
      }
    }
    throw new Error("Invalid state");
  }

  async read(spec: unknown): Promise<unknown> {
    this.readCounts.value++;
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) return undefined;

    const accountId = this.resolvedScopes.get("accountId");
    for (const [, entry] of this.store) {
      if (entry.name === parsed.data.name && entry.accountId === accountId) {
        const result: Record<string, unknown> = {
          id: entry.id,
          name: entry.name,
          label_text: entry.labelText,
          account_id: entry.accountId,
        };
        if (entry.parentId.length > 0) result.parent_id = entry.parentId;
        return result;
      }
    }
    return undefined;
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) throw new Error("Invalid spec for create");
    const accountId = this.resolvedScopes.get("accountId");
    const id = `widget-${String(Date.now())}`;
    const entry: WidgetEntry = {
      id,
      name: parsed.data.name,
      accountId,
      labelText: parsed.data.label ?? "",
      parentId: parsed.data.parentId ?? "",
    };
    this.store.set(id, entry);
    const result: Record<string, unknown> = {
      id,
      name: parsed.data.name,
      label_text: entry.labelText,
      account_id: accountId,
    };
    if (entry.parentId.length > 0) result.parent_id = entry.parentId;
    return result;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) throw new Error("Invalid spec for update");
    const accountId = this.resolvedScopes.get("accountId");
    const name = parsed.data.name;
    const labelText = parsed.data.label ?? "";
    const parentId = parsed.data.parentId ?? "";
    const updated: WidgetEntry = {
      id,
      name,
      accountId,
      labelText,
      parentId,
    };
    this.store.set(id, updated);
    const result: Record<string, unknown> = {
      id,
      name,
      label_text: labelText,
      account_id: accountId,
    };
    if (parentId.length > 0) result.parent_id = parentId;
    return result;
  }
}

// ─── Scoped provider ─────────────────────────────────────────────────────────

class ScopedProvider implements ProviderPort {
  readonly name = "scoped";
  readonly configSchema = z.strictObject({
    accountId: z.string().trim().min(1),
  });

  private store = new Map<string, WidgetEntry>();
  private readCounts = { value: 0 };

  /** Expose read counts for cache assertions */
  get readCallCount(): number {
    return this.readCounts.value;
  }

  async connect(): Promise<void> {
    /* mock — no-op */
  }

  async disconnect(): Promise<void> {
    /* mock — no-op */
  }

  supportedKinds(): string[] {
    return ["Widget"];
  }

  resourceHandler(kind: string, scopes?: ResolvedScopes): ResourcePort {
    if (kind !== "Widget") {
      throw new Error(`Unknown kind: ${kind}`);
    }
    const resolvedScopes = scopes ?? ResolvedScopes.empty;
    return new WidgetResourceHandler(
      this.store,
      this.readCounts,
      resolvedScopes,
    );
  }
}

const scopedAdapter = defineProvider("scoped", () => new ScopedProvider());

// ─── Helpers ─────────────────────────────────────────────────────────────────

function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Index ${String(index)} out of bounds`);
  }
  return value;
}

// ─── End-to-end tests ────────────────────────────────────────────────────────

describe("End-to-end: full pipeline", () => {
  it("creates a new resource through the engine", async () => {
    const adapters = new Map([["scoped", scopedAdapter]]);
    const engine = new SyncEngine(adapters);

    const infra = defineInfra("e2e-create", (infra) => {
      const prov = infra.provider("sp", scopedAdapter, {
        accountId: "acc-123",
      });
      prov.resource("Widget", "my-widget", {
        kind: "Widget",
        name: "my-widget",
        label: "production",
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const result = await engine.execute(ir);

    assert.equal(result.issues.length, 0);
    assert.equal(result.resources.length, 1);
    const res = at(result.resources, 0);
    assert.equal(res.name, "my-widget");
    assert.equal(res.action, "create");
    assert.equal(res.status, "success");
  });

  it("detects convergence — no-op when state matches desired", async () => {
    const provider = new ScopedProvider();
    const adapters = new Map([
      ["scoped", defineProvider("scoped", () => provider)],
    ]);
    const engine = new SyncEngine(adapters);

    // First run: create the widget
    const infra1 = defineInfra("convergence-1", (infra) => {
      const prov = infra.provider("sp", scopedAdapter, {
        accountId: "acc-123",
      });
      prov.resource("Widget", "w1", {
        kind: "Widget",
        name: "w1",
        label: "production",
      });
      return { outputs: {} };
    });

    const result1 = await engine.execute(infra1.toIR());
    assert.equal(at(result1.resources, 0).action, "create");

    // Second run: same desired state — should converge to no-op
    // Need a fresh adapter pointing at the same provider instance
    const engine2 = new SyncEngine(
      new Map([["scoped", defineProvider("scoped", () => provider)]]),
    );
    const infra2 = defineInfra("convergence-2", (infra) => {
      const prov = infra.provider("sp", scopedAdapter, {
        accountId: "acc-123",
      });
      prov.resource("Widget", "w1", {
        kind: "Widget",
        name: "w1",
        label: "production",
      });
      return { outputs: {} };
    });

    const result2 = await engine2.execute(infra2.toIR());
    assert.equal(at(result2.resources, 0).action, "no-op");
  });

  it("resolves refs between resources", async () => {
    const adapters = new Map([["scoped", scopedAdapter]]);
    const engine = new SyncEngine(adapters);

    const infra = defineInfra("e2e-refs", (infra) => {
      const prov = infra.provider("sp", scopedAdapter, {
        accountId: "acc-123",
      });
      prov.resource("Widget", "parent", {
        kind: "Widget",
        name: "parent",
        label: "base",
      });
      prov.resource("Widget", "child", {
        kind: "Widget",
        name: "child",
        label: "derived",
        parentId: new RefToken("parent", "id"),
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const result = await engine.execute(ir);

    assert.equal(result.issues.length, 0);
    assert.equal(result.resources.length, 2);

    // Parent created first (DAG ordering)
    const parent = at(result.resources, 0);
    const child = at(result.resources, 1);
    assert.equal(parent.name, "parent");
    assert.equal(parent.action, "create");
    assert.equal(child.name, "child");
    assert.equal(child.action, "create");
  });

  it("reports validation issues for bad specs", async () => {
    const adapters = new Map([["scoped", scopedAdapter]]);
    const engine = new SyncEngine(adapters);

    const infra = defineInfra("e2e-bad-spec", (infra) => {
      const prov = infra.provider("sp", scopedAdapter, {
        accountId: "acc-123",
      });
      // name is empty — should fail spec validation
      prov.resource("Widget", "bad", {
        kind: "Widget",
        name: "",
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const result = await engine.execute(ir);

    assert.ok(result.issues.length > 0);
  });

  it("dry-run mode plans without creating resources", async () => {
    const provider = new ScopedProvider();
    const adapters = new Map([
      ["scoped", defineProvider("scoped", () => provider)],
    ]);
    const engine = new SyncEngine(adapters);

    const infra = defineInfra("e2e-dry-run", (infra) => {
      const prov = infra.provider("sp", scopedAdapter, {
        accountId: "acc-123",
      });
      prov.resource("Widget", "w1", {
        kind: "Widget",
        name: "w1",
        label: "test",
      });
      return { outputs: {} };
    });

    const result = await engine.execute(infra.toIR(), { mode: "plan" });

    assert.equal(at(result.resources, 0).action, "create");
    assert.equal(at(result.resources, 0).status, "success");

    // Resource should NOT exist in the store — dry run
    // Create a fresh engine to verify no state was persisted
    const engine2 = new SyncEngine(
      new Map([["scoped", defineProvider("scoped", () => provider)]]),
    );
    const result2 = await engine2.execute(infra.toIR());
    // Since it's a dry run, the widget wasn't created — second run still sees create
    assert.equal(at(result2.resources, 0).action, "create");
  });
});

// ─── Cache integration ───────────────────────────────────────────────────────

describe("End-to-end: cache integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infrasync-e2e-cache-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caches read results and avoids re-querying the provider", async () => {
    const provider = new ScopedProvider();
    const adapters = new Map([
      ["scoped", defineProvider("scoped", () => provider)],
    ]);
    const cache = new ResourceCache({ store: new MemoryCacheStore() });

    const infra = defineInfra("cache-test", (infra) => {
      const prov = infra.provider("sp", scopedAdapter, {
        accountId: "acc-123",
      });
      prov.resource("Widget", "w1", {
        kind: "Widget",
        name: "w1",
        label: "cached",
      });
      return { outputs: {} };
    });

    // First run: create the resource (no cache benefit on first run)
    const engine1 = new SyncEngine(adapters);
    const result1 = await engine1.execute(infra.toIR(), { cache });
    assert.equal(at(result1.resources, 0).action, "create");
    const readsAfterCreate = provider.readCallCount;

    // Second run: resource exists — read misses cache (create invalidated it),
    // queries provider, caches the result, converges to no-op
    const engine2 = new SyncEngine(adapters);
    const result2 = await engine2.execute(infra.toIR(), { cache });
    assert.equal(at(result2.resources, 0).action, "no-op");
    const readsAfterSecondRun = provider.readCallCount;
    assert.ok(
      readsAfterSecondRun > readsAfterCreate,
      "Second run should query provider (cache invalidated by create)",
    );

    // Third run: now the cache is primed from the second run's read —
    // no re-query needed
    const engine3 = new SyncEngine(adapters);
    const result3 = await engine3.execute(infra.toIR(), { cache });
    assert.equal(at(result3.resources, 0).action, "no-op");
    assert.equal(
      provider.readCallCount,
      readsAfterSecondRun,
      "Third run should use cached read, not query provider again",
    );
  });

  it("tiered cache backfills from L2 to L1", async () => {
    const l1 = new MemoryCacheStore();
    const l2 = new MemoryCacheStore();
    const tiered = new TieredCacheStore([l1, l2]);
    const cache = new ResourceCache({ store: tiered });

    // Prime through a direct set
    cache.set("test-key", { id: "abc" });

    // Both stores should have it
    assert.ok(l1.get("test-key") !== undefined);
    assert.ok(l2.get("test-key") !== undefined);

    // Evict from L1
    l1.delete("test-key");
    assert.ok(l1.get("test-key") === undefined);

    // Read via cache — should backfill from L2
    const result = cache.get("test-key");
    assert.deepEqual(result, { id: "abc" });
    assert.ok(l1.get("test-key") !== undefined);
  });
});

// ─── Read-mode resources ──────────────────────────────────────────────────────

describe("End-to-end: read-mode resources", () => {
  it("surfaces state for read-mode resources", async () => {
    const provider = new ScopedProvider();
    const adapters = new Map([
      ["scoped", defineProvider("scoped", () => provider)],
    ]);

    // First run: create a managed resource
    const engine1 = new SyncEngine(adapters);
    const createInfra = defineInfra("setup", (infra) => {
      const prov = infra.provider("sp", scopedAdapter, {
        accountId: "acc-123",
      });
      prov.resource("Widget", "w1", {
        kind: "Widget",
        name: "w1",
        label: "managed",
      });
      return { outputs: {} };
    });

    const result1 = await engine1.execute(createInfra.toIR());
    assert.equal(at(result1.resources, 0).action, "create");
    assert.ok(at(result1.resources, 0).state !== undefined);

    // Second run: read the same resource in read mode
    const engine2 = new SyncEngine(adapters);
    const readInfra = defineInfra("read-test", (infra) => {
      const prov = infra.provider("sp", scopedAdapter, {
        accountId: "acc-123",
      });
      // Read-mode: engine queries state but never mutates
      prov.resource(
        "Widget",
        "w1-read",
        {
          kind: "Widget",
          name: "w1",
        },
        { mode: "read" },
      );
      return { outputs: {} };
    });

    const result2 = await engine2.execute(readInfra.toIR());
    assert.equal(result2.resources.length, 1);

    // The read-mode resource
    const readOutcome = at(result2.resources, 0);
    assert.equal(readOutcome.action, "read");
    assert.equal(readOutcome.status, "success");
    // State is surfaced for monitoring/auditing
    assert.ok(readOutcome.state !== undefined);
    // Verify the state has expected fields
    const readState = readOutcome.state;
    assert.ok(
      typeof readState === "object" &&
        readState !== null &&
        "name" in readState,
    );
  });

  it("surfaces undefined state for non-existent read-mode resources", async () => {
    const adapters = new Map([["scoped", scopedAdapter]]);
    const engine = new SyncEngine(adapters);

    const infra = defineInfra("read-missing", (infra) => {
      const prov = infra.provider("sp", scopedAdapter, {
        accountId: "acc-123",
      });
      prov.resource(
        "Widget",
        "missing-read",
        {
          kind: "Widget",
          name: "nonexistent",
        },
        { mode: "read" },
      );
      return { outputs: {} };
    });

    const result = await engine.execute(infra.toIR());
    const readOutcome = at(result.resources, 0);
    assert.equal(readOutcome.action, "read");
    assert.equal(readOutcome.status, "success");
    // Resource doesn't exist — state is undefined
    assert.equal(readOutcome.state, undefined);
  });
});
