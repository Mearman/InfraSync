/**
 * Integration tests exercising the full InfraSync pipeline:
 * authoring → compilation → DAG → ref resolution → plan/apply.
 *
 * Uses a mock adapter to avoid real provider API calls.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { defineInfra } from "../compiler.js";
import { declarative } from "../declarative.js";
import { RefToken, refable } from "../refs.js";
import { defineProvider } from "../provider.js";
import type { ProviderPort, ResourcePort } from "../provider.js";
import { buildDag, topologicalSortByLevel } from "../dag.js";
import { computePlan } from "../plan.js";
import { SyncEngine } from "../sync.js";
import { deepEqual, resolveRefs } from "../resource.js";
import { DagCycleError } from "../errors.js";

// ─── Mock adapter ────────────────────────────────────────────────────────────

const mockSpecSchema = z.object({
  kind: z.literal("MockResource"),
  name: z.string().trim().min(1),
  /** Uses refable so tests can pass RefToken values without type assertions. */
  value: refable(z.string().trim()).optional(),
  tags: z.record(z.string(), z.string().trim()).optional(),
});

const resolvedSpecSchema = z.object({
  kind: z.literal("MockResource"),
  name: z.string().trim().min(1),
  value: z.string().trim().optional(),
  tags: z.record(z.string(), z.string().trim()).optional(),
});

const mockStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    value: z.string().trim().optional(),
    status: z.string().trim(),
  })
  .brand<"MockState">()
  .readonly();

const mockIdentitySchema = mockSpecSchema.pick({ name: true });
const mockDesiredStateSchema = mockSpecSchema.pick({ value: true });

interface MockStoreEntry {
  name: string;
  status: string;
  value?: string;
}

/**
 * In-memory mock resource handler.
 * Stores created resources in a Map so reads/find work.
 */
class MockResourceHandler implements ResourcePort<
  typeof mockSpecSchema,
  typeof mockStateSchema
> {
  readonly kind = "MockResource";
  readonly specSchema = mockSpecSchema;
  readonly stateSchema = mockStateSchema;
  readonly identitySchema = mockIdentitySchema;
  readonly desiredStateSchema = mockDesiredStateSchema;

  constructor(private readonly store: Map<string, MockStoreEntry>) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      if (typeof state.id === "string") return state.id;
    }
    throw new Error("Invalid state");
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) return undefined;
    for (const [, entry] of this.store) {
      if (entry.name === parsed.data.name) {
        const result: Record<string, unknown> = {
          id: "existing-id",
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
    const parsed = resolvedSpecSchema.safeParse(spec);
    const id = `mock-${String(Date.now())}`;
    const name = parsed.success ? parsed.data.name : "unknown";
    const value = parsed.success ? parsed.data.value : undefined;
    const entry: MockStoreEntry = { name, status: "active" };
    if (value !== undefined) entry.value = value;
    this.store.set(id, entry);
    const result: Record<string, unknown> = { id, name, status: "active" };
    if (value !== undefined) result.value = value;
    return result;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    const existing = this.store.get(id);
    const name = parsed.success
      ? parsed.data.name
      : (existing?.name ?? "unknown");
    const value = parsed.success ? parsed.data.value : existing?.value;
    const entry: MockStoreEntry = { name, status: "active" };
    if (value !== undefined) entry.value = value;
    this.store.set(id, entry);
    const result: Record<string, unknown> = { id, name, status: "active" };
    if (value !== undefined) result.value = value;
    return result;
  }
}

/** Mock provider that uses an in-memory store. */
class MockProvider implements ProviderPort {
  readonly name = "mock";
  readonly configSchema = z.strictObject({
    region: z.string().trim().optional(),
  });

  private store = new Map<string, MockStoreEntry>();

  async connect(): Promise<void> {
    // No-op
  }

  async disconnect(): Promise<void> {
    // No-op
  }

  supportedKinds(): string[] {
    return ["MockResource"];
  }

  resourceHandler(kind: string): ResourcePort {
    if (kind === "MockResource") {
      return new MockResourceHandler(this.store);
    }
    throw new Error(`Unknown kind: ${kind}`);
  }
}

const mockAdapter = defineProvider("mock", () => new MockProvider());

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Non-null assertion for array index access under noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Index ${String(index)} out of bounds`);
  }
  return value;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("IR types and compilation", () => {
  it("compiles an empty infra to an empty IR", () => {
    const infra = defineInfra("empty", () => ({ outputs: {} }));
    const ir = infra.toIR();

    assert.equal(ir.name, "empty");
    assert.equal(ir.providers.length, 0);
    assert.equal(ir.resources.length, 0);
  });

  it("compiles provider instances into the IR", () => {
    const infra = defineInfra("test", (infra) => {
      infra.provider("mock1", mockAdapter, { region: "eu-west-1" });
      infra.provider("mock2", mockAdapter, {});
      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.providers.length, 2);
    const p0 = at(ir.providers, 0);
    const p1 = at(ir.providers, 1);
    assert.equal(p0.key, "mock1");
    assert.equal(p0.adapterName, "mock");
    assert.equal(p1.key, "mock2");
  });

  it("compiles resources with correct metadata", () => {
    const infra = defineInfra("test", (infra) => {
      const prov = infra.provider("mock1", mockAdapter, {});
      prov.resource("MockResource", "res-a", {
        kind: "MockResource",
        name: "resource-a",
        value: "hello",
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.resources.length, 1);

    const res = at(ir.resources, 0);
    assert.equal(res.name, "res-a");
    assert.equal(res.provider, "mock1");
    assert.equal(res.kind, "MockResource");
    assert.equal(res.mode, "manage");
    assert.equal(res.dependsOn.length, 0);
  });

  it("serialises RefTokens into RefTokenIR", () => {
    const infra = defineInfra("test", (infra) => {
      const prov = infra.provider("mock1", mockAdapter, {});
      prov.resource("MockResource", "res-a", {
        kind: "MockResource",
        name: "a",
        value: "concrete",
      });
      prov.resource("MockResource", "res-b", {
        kind: "MockResource",
        name: "b",
        value: new RefToken("res-a", "value"),
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.resources.length, 2);

    // res-b's value should be a RefTokenIR
    const resB = at(ir.resources, 1);
    const specValue = resB.spec.value;
    assert.ok(
      typeof specValue === "object" &&
        specValue !== null &&
        "$ref" in specValue,
      `Expected RefTokenIR, got: ${JSON.stringify(specValue)}`,
    );
  });

  it("compiles child scopes into the same flat IR", () => {
    const infra = defineInfra("test", (infra) => {
      const prov = infra.provider("mock1", mockAdapter, {});
      prov.resource("MockResource", "root-res", {
        kind: "MockResource",
        name: "root",
      });

      infra.infra("child", (child) => {
        const childProv = child.provider("mock1", mockAdapter, {});
        childProv.resource("MockResource", "child-res", {
          kind: "MockResource",
          name: "child",
        });
      });

      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.resources.length, 2);
    assert.equal(at(ir.resources, 0).name, "root-res");
    assert.equal(at(ir.resources, 1).name, "child-res");
    // Provider is registered twice (once in each scope)
    assert.equal(ir.providers.length, 2);
  });

  it("compiles declarative fragments", () => {
    const infra = defineInfra("test", (infra) => {
      infra.provider("mock1", mockAdapter, {});

      infra.use(
        declarative("ops", {
          resources: [
            {
              provider: "mock1",
              kind: "MockResource",
              name: "dec-res",
            },
          ],
        }),
      );

      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.resources.length, 1);
    assert.equal(at(ir.resources, 0).name, "dec-res");
  });
});

describe("DAG builder", () => {
  it("sorts independent resources in any order", () => {
    const infra = defineInfra("test", (infra) => {
      const prov = infra.provider("m", mockAdapter, {});
      prov.resource("MockResource", "a", { kind: "MockResource", name: "a" });
      prov.resource("MockResource", "b", { kind: "MockResource", name: "b" });
      prov.resource("MockResource", "c", { kind: "MockResource", name: "c" });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const dag = buildDag(ir.resources);
    const levels = topologicalSortByLevel(dag);

    // All independent — single level
    assert.equal(levels.length, 1);
    assert.equal(at(levels, 0).length, 3);
  });

  it("detects dependency cycles", () => {
    const infra = defineInfra("test", (infra) => {
      const prov = infra.provider("m", mockAdapter, {});
      prov.resource("MockResource", "a", {
        kind: "MockResource",
        name: "a",
        value: new RefToken("b", "value"),
      });
      prov.resource("MockResource", "b", {
        kind: "MockResource",
        name: "b",
        value: new RefToken("a", "value"),
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const dag = buildDag(ir.resources);
    assert.throws(
      () => topologicalSortByLevel(dag),
      (err: unknown) => err instanceof DagCycleError,
    );
  });

  it("groups dependent resources into depth levels", () => {
    const infra = defineInfra("test", (infra) => {
      const prov = infra.provider("m", mockAdapter, {});
      // a → b → c (chain)
      prov.resource("MockResource", "a", { kind: "MockResource", name: "a" });
      prov.resource("MockResource", "b", {
        kind: "MockResource",
        name: "b",
        value: new RefToken("a", "value"),
      });
      prov.resource("MockResource", "c", {
        kind: "MockResource",
        name: "c",
        value: new RefToken("b", "value"),
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const dag = buildDag(ir.resources);
    const levels = topologicalSortByLevel(dag);

    assert.equal(levels.length, 3);
    // Level 0: a (no deps)
    assert.deepEqual(
      at(levels, 0).map((n) => n.resource.name),
      ["a"],
    );
    // Level 1: b (depends on a)
    assert.deepEqual(
      at(levels, 1).map((n) => n.resource.name),
      ["b"],
    );
    // Level 2: c (depends on b)
    assert.deepEqual(
      at(levels, 2).map((n) => n.resource.name),
      ["c"],
    );
  });
});

describe("Ref resolution", () => {
  it("replaces RefTokenIR paths with concrete state values", () => {
    const spec = {
      kind: "MockResource",
      name: "b",
      value: { $ref: { resource: "a", path: "value" } },
    };

    const stateMap = new Map<string, unknown>();
    stateMap.set("a", {
      id: "id-1",
      name: "a",
      value: "resolved",
      status: "active",
    });

    const resolved = resolveRefs(spec, stateMap);
    assert.ok(typeof resolved === "object" && resolved !== null);
    if ("value" in resolved) {
      assert.equal(resolved.value, "resolved");
    } else {
      assert.fail("Expected 'value' property on resolved spec");
    }
  });

  it("resolves nested dot-notation paths", () => {
    const spec = {
      config: {
        $ref: { resource: "cluster", path: "output.endpoint" },
      },
    };

    const stateMap = new Map<string, unknown>();
    stateMap.set("cluster", {
      output: { endpoint: "https://api.example.com" },
    });

    const resolved = resolveRefs(spec, stateMap);
    assert.ok(typeof resolved === "object" && resolved !== null);
    if ("config" in resolved) {
      assert.equal(resolved.config, "https://api.example.com");
    } else {
      assert.fail("Expected 'config' property on resolved spec");
    }
  });

  it("throws on unresolvable refs", () => {
    const spec = {
      value: { $ref: { resource: "missing", path: "id" } },
    };

    assert.throws(() => resolveRefs(spec, new Map()), /Unresolved ref/);
  });
});

describe("Deep equality", () => {
  it("compares primitives", () => {
    assert.ok(deepEqual(1, 1));
    assert.ok(deepEqual("hello", "hello"));
    assert.ok(deepEqual(true, true));
    assert.ok(!deepEqual(1, 2));
    assert.ok(!deepEqual("a", "b"));
  });

  it("compares nested objects", () => {
    assert.ok(deepEqual({ a: { b: 1 } }, { a: { b: 1 } }));
    assert.ok(!deepEqual({ a: { b: 1 } }, { a: { b: 2 } }));
  });

  it("compares arrays", () => {
    assert.ok(deepEqual([1, 2, 3], [1, 2, 3]));
    assert.ok(!deepEqual([1, 2], [1, 2, 3]));
  });
});

describe("Plan computation", () => {
  it("plans create when no state exists", () => {
    assert.equal(computePlan("manage", undefined), "create");
  });

  it("plans update when state exists", () => {
    assert.equal(computePlan("manage", { id: "1" }), "update");
  });

  it("always reads for read-mode resources", () => {
    assert.equal(computePlan("read", undefined), "read");
    assert.equal(computePlan("read", { id: "1" }), "read");
  });
});

describe("Sync engine", () => {
  it("creates a resource that does not exist", async () => {
    const adapters = new Map([["mock", mockAdapter]]);
    const engine = new SyncEngine(adapters);

    const infra = defineInfra("create-test", (infra) => {
      const prov = infra.provider("m", mockAdapter, {});
      prov.resource("MockResource", "res-1", {
        kind: "MockResource",
        name: "test-resource",
        value: "hello",
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const result = await engine.execute(ir);

    assert.equal(result.issues.length, 0);
    assert.equal(result.resources.length, 1);
    const res = at(result.resources, 0);
    assert.equal(res.name, "res-1");
    assert.equal(res.action, "create");
    assert.equal(res.status, "success");
  });

  it("plans without applying in dry-run mode", async () => {
    const adapters = new Map([["mock", mockAdapter]]);
    const engine = new SyncEngine(adapters);

    const infra = defineInfra("plan-test", (infra) => {
      const prov = infra.provider("m", mockAdapter, {});
      prov.resource("MockResource", "res-1", {
        kind: "MockResource",
        name: "test-resource",
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const result = await engine.execute(ir, { mode: "plan" });

    assert.equal(result.resources.length, 1);
    const res = at(result.resources, 0);
    assert.equal(res.action, "create");
    assert.equal(res.status, "success");
  });

  it("reports issues for unknown adapters", async () => {
    const adapters = new Map<string, ReturnType<typeof defineProvider>>();
    const engine = new SyncEngine(adapters);

    const infra = defineInfra("unknown-adapter", (infra) => {
      infra.provider("m", mockAdapter, {});
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const result = await engine.execute(ir);

    assert.ok(result.issues.length > 0);
    const issue = at(result.issues, 0);
    assert.ok(
      issue.message.includes("Unknown adapter"),
      `Expected "Unknown adapter" in message, got: ${issue.message}`,
    );
  });
});

describe("Secret resolution", () => {
  it("resolves env secret sources", () => {
    process.env._TEST_SECRET = "secret-value";

    const infra = defineInfra("secret-test", (infra) => {
      infra.provider("m", mockAdapter, {
        token: infra.secret.env("_TEST_SECRET"),
      });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const config = at(ir.providers, 0).config;

    // Config should contain a serialisable secret descriptor
    assert.ok(
      typeof config.token === "object" &&
        config.token !== null &&
        "$secret" in config.token,
    );

    delete process.env._TEST_SECRET;
  });
});
