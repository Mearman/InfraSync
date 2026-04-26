/**
 * Integration tests for the plugin system (customResource).
 *
 * Verifies that custom resource plugins:
 * - Integrate as ProviderAdapter instances
 * - Validate spec through Zod schemas before calling handlers
 * - Route read/create/update to the correct handler functions
 * - Work with the engine's ProviderPort interface
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { customResource } from "../plugin.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

const testSpecSchema = z.object({
  kind: z.literal("TestWidget"),
  name: z.string().trim().min(1),
  region: z.string().trim().min(1),
  enabled: z.boolean().default(true),
});

type TestSpec = z.infer<typeof testSpecSchema>;

function createTestPlugin(overrides?: {
  read?: (spec: TestSpec) => Promise<unknown>;
  create?: (spec: TestSpec) => Promise<unknown>;
  update?: (id: string, spec: TestSpec) => Promise<unknown>;
}) {
  const readSpy = mock.fn(
    overrides?.read ??
      ((spec: TestSpec) =>
        Promise.resolve({
          id: `widget-${spec.name}`,
          name: spec.name,
          region: spec.region,
          enabled: spec.enabled,
        })),
  );
  const createSpy = mock.fn(
    overrides?.create ??
      ((spec: TestSpec) =>
        Promise.resolve({
          id: `new-${spec.name}`,
          name: spec.name,
          region: spec.region,
          enabled: spec.enabled,
        })),
  );
  const updateSpy = mock.fn(
    overrides?.update ??
      ((id: string, spec: TestSpec) =>
        Promise.resolve({
          id,
          name: spec.name,
          region: spec.region,
          enabled: spec.enabled,
        })),
  );

  const adapter = customResource({
    kind: "TestWidget",
    specSchema: testSpecSchema,
    stateSchema: z.json(),
    handlers: {
      read: readSpy,
      create: createSpy,
      update: updateSpy,
    },
  });

  return { adapter, readSpy, createSpy, updateSpy };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("customResource plugin", () => {
  it("returns a valid ProviderAdapter", () => {
    const { adapter } = createTestPlugin();
    assert.equal(adapter.adapterName, "plugin:TestWidget");
    assert.equal(typeof adapter.create, "function");
  });

  it("create() returns a ProviderPort with correct kind", () => {
    const { adapter } = createTestPlugin();
    const port = adapter.create();
    assert.equal(port.name, "plugin:TestWidget");
    assert.deepEqual(port.supportedKinds(), ["TestWidget"]);
  });

  it("connect() and disconnect() are no-ops", async () => {
    const { adapter } = createTestPlugin();
    const port = adapter.create();
    // Should not throw
    await port.connect({});
    await port.disconnect();
  });

  it("resourceHandler returns the custom ResourcePort", () => {
    const { adapter } = createTestPlugin();
    const port = adapter.create();
    const handler = port.resourceHandler("TestWidget");
    assert.equal(handler.kind, "TestWidget");
  });

  it("resourceHandler throws for unsupported kind", () => {
    const { adapter } = createTestPlugin();
    const port = adapter.create();
    assert.throws(
      () => port.resourceHandler("OtherKind"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /does not support kind/);
        return true;
      },
    );
  });

  it("read validates spec and calls handler", async () => {
    const { adapter, readSpy } = createTestPlugin();
    const port = adapter.create();
    const handler = port.resourceHandler("TestWidget");

    const result = await handler.read({
      kind: "TestWidget",
      name: "my-widget",
      region: "us-east-1",
    });

    assert.equal(readSpy.mock.callCount(), 1);
    assert.ok(typeof result === "object" && result !== null);
    assert.equal((result as { readonly name: string }).name, "my-widget");
  });

  it("read returns undefined when handler returns undefined", async () => {
    const { adapter } = createTestPlugin({
      read: () => Promise.resolve(undefined),
    });
    const port = adapter.create();
    const handler = port.resourceHandler("TestWidget");

    const result = await handler.read({
      kind: "TestWidget",
      name: "missing",
      region: "us-east-1",
    });
    assert.equal(result, undefined);
  });

  it("create validates spec and calls handler", async () => {
    const { adapter, createSpy } = createTestPlugin();
    const port = adapter.create();
    const handler = port.resourceHandler("TestWidget");

    const result = await handler.create({
      kind: "TestWidget",
      name: "new-widget",
      region: "eu-west-1",
    });

    assert.equal(createSpy.mock.callCount(), 1);
    assert.ok(typeof result === "object" && result !== null);
    assert.equal((result as { readonly id: string }).id, "new-new-widget");
  });

  it("update validates spec and calls handler with id", async () => {
    const { adapter, updateSpy } = createTestPlugin();
    const port = adapter.create();
    const handler = port.resourceHandler("TestWidget");

    const result = await handler.update("widget-123", {
      kind: "TestWidget",
      name: "updated-widget",
      region: "ap-south-1",
    });

    assert.equal(updateSpy.mock.callCount(), 1);
    assert.ok(typeof result === "object" && result !== null);
    assert.equal((result as { readonly id: string }).id, "widget-123");
  });

  it("throws on invalid spec", async () => {
    const { adapter } = createTestPlugin();
    const port = adapter.create();
    const handler = port.resourceHandler("TestWidget");

    await assert.rejects(
      () => handler.create({ kind: "TestWidget" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /spec validation failed/);
        return true;
      },
    );
  });

  it("getStateId extracts id from state by default", () => {
    const { adapter } = createTestPlugin();
    const port = adapter.create();
    const handler = port.resourceHandler("TestWidget");

    const id = handler.getStateId({ id: "abc-123", name: "test" });
    assert.equal(id, "abc-123");
  });

  it("supports custom getStateId", () => {
    const adapter = customResource({
      kind: "CustomIdWidget",
      specSchema: testSpecSchema,
      stateSchema: z.json(),
      handlers: {
        read: () => Promise.resolve(undefined),
        create: (spec) => Promise.resolve({ widgetId: `w-${spec.name}` }),
        update: (id, spec) =>
          Promise.resolve({ widgetId: id, name: spec.name }),
      },
      getStateId: (state: unknown) => {
        if (
          typeof state === "object" &&
          state !== null &&
          "widgetId" in state
        ) {
          const value = (state as { readonly widgetId: unknown }).widgetId;
          if (typeof value === "string") return value;
        }
        throw new Error("No widgetId");
      },
    });

    const port = adapter.create();
    const handler = port.resourceHandler("CustomIdWidget");

    const id = handler.getStateId({ widgetId: "w-test", name: "test" });
    assert.equal(id, "w-test");
  });

  it("specSchema applies defaults from schema", async () => {
    const { adapter, createSpy } = createTestPlugin();
    const port = adapter.create();
    const handler = port.resourceHandler("TestWidget");

    // enabled has default(true) — omitted from input
    await handler.create({
      kind: "TestWidget",
      name: "no-enabled",
      region: "us-east-1",
    });

    assert.equal(createSpy.mock.callCount(), 1);
    const firstCall = createSpy.mock.calls[0];
    assert.ok(firstCall !== undefined, "expected at least one call");
    const spec = firstCall.arguments[0];
    assert.ok(typeof spec === "object" && spec !== null);
    assert.equal(
      (spec as { readonly enabled: boolean }).enabled,
      true,
      "default should be applied",
    );
  });
});
