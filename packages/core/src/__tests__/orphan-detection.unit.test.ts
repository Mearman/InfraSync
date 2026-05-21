/**
 * Unit tests for orphan detection.
 *
 * Tests the read-phase orphan detection logic: finding resources in the
 * provider that are not present in the IR, excluding handlers without
 * list(), and the plan-phase orphan action generation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { defineInfra } from "../compiler.js";
import { defineProvider } from "../provider.js";
import type {
  ProviderPort,
  ResourcePort,
  ResolvedScopes,
  ListedResource,
} from "../provider.js";
import { planPhase } from "../plan-phase.js";
import { readPhase } from "../read-phase.js";

// ─── Test schemas ────────────────────────────────────────────────────────────

const testSpecSchema = z.object({
  kind: z.literal("TestResource"),
  name: z.string().trim().min(1),
  value: z.string().trim().optional(),
});

const testStateSchema = z.looseObject({
  id: z.string().trim(),
  name: z.string().trim(),
  value: z.string().trim().optional(),
  status: z.string().trim(),
});

const testIdentitySchema = testSpecSchema.pick({ name: true });
const testDesiredStateSchema = testSpecSchema.pick({ value: true });

// ─── Test store ──────────────────────────────────────────────────────────────

interface StoreEntry {
  readonly name: string;
  readonly value?: string;
  readonly status: string;
}

// ─── Handler with list() support ─────────────────────────────────────────────

class ListableResourceHandler implements ResourcePort<
  typeof testSpecSchema,
  typeof testStateSchema
> {
  readonly kind = "TestResource";
  readonly specSchema = testSpecSchema;
  readonly stateSchema = testStateSchema;
  readonly identitySchema = testIdentitySchema;
  readonly desiredStateSchema = testDesiredStateSchema;

  constructor(private readonly store: Map<string, StoreEntry>) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      if (typeof state.id === "string") return state.id;
    }
    throw new Error("Invalid state");
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = testSpecSchema.safeParse(spec);
    if (!parsed.success) return undefined;
    for (const [id, entry] of this.store) {
      if (entry.name === parsed.data.name) {
        const result: Record<string, unknown> = {
          id,
          name: entry.name,
          status: entry.status,
        };
        if (entry.value !== undefined) result.value = entry.value;
        return result;
      }
    }
    return undefined;
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = testSpecSchema.safeParse(spec);
    const id = `test-${String(Date.now())}`;
    const name = parsed.success ? parsed.data.name : "unknown";
    const value = parsed.success ? parsed.data.value : undefined;
    this.store.set(
      id,
      value !== undefined
        ? { name, status: "active", value }
        : { name, status: "active" },
    );
    const result: Record<string, unknown> = { id, name, status: "active" };
    if (value !== undefined) result.value = value;
    return result;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = testSpecSchema.safeParse(spec);
    const existing = this.store.get(id);
    const name = parsed.success
      ? parsed.data.name
      : (existing?.name ?? "unknown");
    const value = parsed.success ? parsed.data.value : existing?.value;
    this.store.set(
      id,
      value !== undefined
        ? { name, status: "active", value }
        : { name, status: "active" },
    );
    const result: Record<string, unknown> = { id, name, status: "active" };
    if (value !== undefined) result.value = value;
    return result;
  }

  async list(): Promise<readonly ListedResource[]> {
    const results: ListedResource[] = [];
    for (const [id, entry] of this.store) {
      const identity: Record<string, unknown> = { name: entry.name };
      const state: Record<string, unknown> = {
        id,
        name: entry.name,
        status: entry.status,
      };
      if (entry.value !== undefined) {
        state.value = entry.value;
      }
      results.push({ stateId: id, identity, state });
    }
    return results;
  }
}

// ─── Handler without list() ──────────────────────────────────────────────────

class NonListableResourceHandler implements ResourcePort<
  typeof testSpecSchema,
  typeof testStateSchema
> {
  readonly kind = "TestResource";
  readonly specSchema = testSpecSchema;
  readonly stateSchema = testStateSchema;
  readonly identitySchema = testIdentitySchema;
  readonly desiredStateSchema = testDesiredStateSchema;

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      if (typeof state.id === "string") return state.id;
    }
    throw new Error("Invalid state");
  }

  async read(_spec: unknown): Promise<unknown> {
    return undefined;
  }

  async create(_spec: unknown): Promise<unknown> {
    return { id: "new-id", name: "created", status: "active" };
  }

  async update(_id: string, _spec: unknown): Promise<unknown> {
    return { id: _id, name: "updated", status: "active" };
  }
}

// ─── Provider with listable handler ──────────────────────────────────────────

class ListableProvider implements ProviderPort {
  readonly name = "listable";
  readonly configSchema = z.strictObject({});

  private store = new Map<string, StoreEntry>();

  constructor(prePopulated?: Map<string, StoreEntry>) {
    if (prePopulated !== undefined) {
      this.store = prePopulated;
    }
  }

  async connect(): Promise<void> {
    /* no-op */
  }
  async disconnect(): Promise<void> {
    /* no-op */
  }

  supportedKinds(): string[] {
    return ["TestResource"];
  }

  resourceHandler(kind: string, _scopes: ResolvedScopes): ResourcePort {
    if (kind === "TestResource") {
      return new ListableResourceHandler(this.store);
    }
    throw new Error(`Unknown kind: ${kind}`);
  }
}

// ─── Provider without listable handler ───────────────────────────────────────

class NonListableProvider implements ProviderPort {
  readonly name = "nonlistable";
  readonly configSchema = z.strictObject({});

  async connect(): Promise<void> {
    /* no-op */
  }
  async disconnect(): Promise<void> {
    /* no-op */
  }

  supportedKinds(): string[] {
    return ["TestResource"];
  }

  resourceHandler(kind: string, _scopes: ResolvedScopes): ResourcePort {
    if (kind === "TestResource") {
      return new NonListableResourceHandler();
    }
    throw new Error(`Unknown kind: ${kind}`);
  }
}

// ─── Adapters ────────────────────────────────────────────────────────────────

const nonListableAdapter = defineProvider(
  "nonlistable",
  () => new NonListableProvider(),
);

/** Non-null assertion for array index access under noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Index ${String(index)} out of bounds`);
  }
  return value;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Orphan detection", () => {
  it("finds resources in provider not in IR", async () => {
    // Pre-populate the provider with a resource not in the IR
    const store = new Map<string, StoreEntry>([
      ["orphan-1", { name: "orphan-resource", status: "active" }],
    ]);
    const adapter = defineProvider(
      "listable",
      () => new ListableProvider(store),
    );

    // IR has no resources — everything in the provider is an orphan
    const infra = defineInfra("orphan-test", (infra) => {
      infra.provider("m", adapter, {});
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const adapters = new Map([["listable", adapter]]);

    const result = await readPhase({
      ir,
      adapters,
      orphanDetection: { enabled: true },
    });

    assert.equal(result.issues.length, 0);
    assert.ok(result.orphans !== undefined, "Expected orphans to be defined");
    assert.equal(result.orphans.length, 1);

    const orphan = at(result.orphans, 0);
    assert.equal(orphan.kind, "TestResource");
    assert.equal(orphan.stateId, "orphan-1");
    assert.equal(orphan.identity.name, "orphan-resource");
  });

  it("does not produce orphans for resources in the IR", async () => {
    // Pre-populate the provider with a resource that IS in the IR
    const store = new Map<string, StoreEntry>([
      ["managed-1", { name: "managed-resource", status: "active" }],
    ]);
    const adapter = defineProvider(
      "listable",
      () => new ListableProvider(store),
    );

    const infra = defineInfra("no-orphan-test", (infra) => {
      const prov = infra.provider("m", adapter, {});
      prov.resource("TestResource", "res-1", {
        kind: "TestResource",
        name: "managed-resource",
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const adapters = new Map([["listable", adapter]]);

    const result = await readPhase({
      ir,
      adapters,
      orphanDetection: { enabled: true },
    });

    assert.equal(
      result.issues.length,
      0,
      `Issues: ${JSON.stringify(result.issues)}`,
    );
    if (result.orphans !== undefined && result.orphans.length > 0) {
      assert.fail(`Unexpected orphans: ${JSON.stringify(result.orphans)}`);
    }
  });

  it("excludes handlers without list() from orphan detection", async () => {
    // Use a provider whose handler does NOT implement list()
    const infra = defineInfra("no-list-test", (infra) => {
      infra.provider("m", nonListableAdapter, {});
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const adapters = new Map([["nonlistable", nonListableAdapter]]);

    const result = await readPhase({
      ir,
      adapters,
      orphanDetection: { enabled: true },
    });

    assert.equal(result.issues.length, 0);
    // No orphans — handler doesn't implement list(), so orphan detection
    // skips it. Returns empty array since orphan detection was enabled.
    assert.ok(result.orphans !== undefined);
    assert.equal(result.orphans.length, 0);
  });

  it("returns undefined orphans when orphanDetection is not enabled", async () => {
    const store = new Map<string, StoreEntry>([
      ["orphan-1", { name: "orphan-resource", status: "active" }],
    ]);
    const adapter = defineProvider(
      "listable",
      () => new ListableProvider(store),
    );

    const infra = defineInfra("disabled-test", (infra) => {
      infra.provider("m", adapter, {});
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const adapters = new Map([["listable", adapter]]);

    const result = await readPhase({
      ir,
      adapters,
      // orphanDetection not provided
    });

    assert.equal(result.issues.length, 0);
    assert.equal(result.orphans, undefined);
  });

  it("returns undefined orphans when orphanDetection is disabled", async () => {
    const store = new Map<string, StoreEntry>([
      ["orphan-1", { name: "orphan-resource", status: "active" }],
    ]);
    const adapter = defineProvider(
      "listable",
      () => new ListableProvider(store),
    );

    const infra = defineInfra("disabled-test", (infra) => {
      infra.provider("m", adapter, {});
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const adapters = new Map([["listable", adapter]]);

    const result = await readPhase({
      ir,
      adapters,
      orphanDetection: { enabled: false },
    });

    assert.equal(result.issues.length, 0);
    assert.equal(result.orphans, undefined);
  });
});

describe("Orphan plan actions", () => {
  it("produces delete actions when pruneOrphans is true", () => {
    const store = new Map<string, StoreEntry>([
      ["orphan-1", { name: "orphan-resource", status: "active" }],
    ]);
    const adapter = defineProvider(
      "listable",
      () => new ListableProvider(store),
    );

    const infra = defineInfra("prune-test", (infra) => {
      const prov = infra.provider("m", adapter, {});
      prov.resource("TestResource", "res-1", {
        kind: "TestResource",
        name: "managed-resource",
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();

    // Simulate read phase output with orphans
    const orphanId = "orphan-1";
    const orphans = [
      {
        kind: "TestResource",
        stateId: orphanId,
        identity: { name: "orphan-resource" },
        state: { id: orphanId, name: "orphan-resource", status: "active" },
      },
    ];

    // We need instances for the plan phase — but we can construct
    // the plan phase input directly
    const providerInstance = adapter.create();
    const instances = new Map([["m", providerInstance]]);

    // Plan without pruning — orphans reported as issues
    const planNoPrune = planPhase({
      ir,
      stateMap: {
        get: () => undefined,
        toJSON: () => ({}),
      } as never,
      instances,
      configs: new Map(),
      orphans,
      pruneOrphans: false,
    });

    assert.ok(planNoPrune.issues.length > 0, "Expected orphan warning issues");
    const orphanIssue = planNoPrune.issues.find((i) =>
      i.message.includes("Orphan detected"),
    );
    assert.ok(
      orphanIssue !== undefined,
      `Expected 'Orphan detected' in issues, got: ${JSON.stringify(planNoPrune.issues)}`,
    );

    // Plan with pruning — delete actions produced
    const planPrune = planPhase({
      ir,
      stateMap: {
        get: () => undefined,
        toJSON: () => ({}),
      } as never,
      instances,
      configs: new Map(),
      orphans,
      pruneOrphans: true,
    });

    const deleteActions = planPrune.actionDag.actions.filter(
      (a) => a.action === "delete",
    );
    assert.equal(deleteActions.length, 1);

    const deleteAction = at(deleteActions, 0);
    assert.equal(deleteAction.kind, "TestResource");
    assert.equal(deleteAction.resource, orphanId);
    assert.equal(
      deleteAction.deps.length,
      0,
      "Orphan deletes should have no dependencies",
    );
  });

  it("does not produce orphan actions when orphans are empty", () => {
    const adapter = defineProvider("listable", () => new ListableProvider());
    const infra = defineInfra("no-orphans-test", (infra) => {
      const prov = infra.provider("m", adapter, {});
      prov.resource("TestResource", "res-1", {
        kind: "TestResource",
        name: "test-resource",
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const providerInstance = adapter.create();
    const instances = new Map([["m", providerInstance]]);

    const planResult = planPhase({
      ir,
      stateMap: {
        get: () => undefined,
        toJSON: () => ({}),
      } as never,
      instances,
      configs: new Map(),
      orphans: [],
      pruneOrphans: true,
    });

    const deleteActions = planResult.actionDag.actions.filter(
      (a) => a.action === "delete",
    );
    assert.equal(deleteActions.length, 0);
    assert.equal(planResult.issues.length, 0);
  });
});
