/**
 * Tests for the precondition engine — cross-resource ordering constraints
 * and end-to-end engine integration.
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
} from "../provider.js";
import { SyncEngine } from "../sync.js";
import type { PreconditionDeclaration } from "../transitions.js";

/** Non-null assertion for array find results. */
function findOrThrow<T>(arr: readonly T[], predicate: (item: T) => boolean): T {
  const result = arr.find(predicate);
  if (result === undefined) throw new Error("Item not found");
  return result;
}

// ─── Mock adapters for guard tests ───────────────────────────────────────────

/**
 * A "lock" resource — simulates something that must be absent before
 * a "guarded" resource can update certain fields.
 */
const lockSpecSchema = z.strictObject({
  kind: z.literal("Lock"),
  name: z.string().trim().min(1),
  domain: z.string().trim().min(1),
});

const lockStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    domain: z.string().trim(),
  })
  .readonly();

const lockIdentitySchema = z.strictObject({
  kind: z.literal("Lock"),
  name: z.string().trim().min(1),
});

const lockDesiredStateSchema = z.object({
  domain: lockSpecSchema.shape.domain,
});

interface LockEntry {
  name: string;
  domain: string;
}

class LockResource implements ResourcePort {
  readonly kind = "Lock";
  readonly specSchema = lockSpecSchema;
  readonly stateSchema = lockStateSchema;
  readonly identitySchema = lockIdentitySchema;
  readonly desiredStateSchema = lockDesiredStateSchema;

  constructor(private readonly store: Map<string, LockEntry>) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      return (state as { id: string }).id;
    }
    throw new Error("Invalid state");
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = lockSpecSchema.safeParse(spec);
    if (!parsed.success) return undefined;
    for (const [id, entry] of this.store) {
      if (entry.name === parsed.data.name) {
        return { id, name: entry.name, domain: entry.domain };
      }
    }
    return undefined;
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = lockSpecSchema.safeParse(spec);
    if (!parsed.success) throw new Error("Invalid spec");
    const id = `lock-${String(Date.now())}`;
    this.store.set(id, {
      name: parsed.data.name,
      domain: parsed.data.domain,
    });
    return { id, name: parsed.data.name, domain: parsed.data.domain };
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = lockSpecSchema.safeParse(spec);
    if (!parsed.success) throw new Error("Invalid spec");
    this.store.set(id, {
      name: parsed.data.name,
      domain: parsed.data.domain,
    });
    return { id, name: parsed.data.name, domain: parsed.data.domain };
  }

  async delete(state: unknown): Promise<void> {
    if (typeof state === "object" && state !== null && "id" in state) {
      this.store.delete((state as { id: string }).id);
    }
  }
}

/**
 * A "guarded" resource — simulates a resource whose `secret` field
 * can only be updated when the matching lock is absent.
 */
const guardedSpecSchema = z.strictObject({
  kind: z.literal("Guarded"),
  name: z.string().trim().min(1),
  domain: z.string().trim().min(1),
  value: z.string().trim().min(1),
  secret: z.string().trim().min(1).optional(),
});

const guardedStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    domain: z.string().trim(),
    value: z.string().trim(),
    secret: z.string().trim().optional(),
  })
  .readonly();

const guardedIdentitySchema = z.strictObject({
  kind: z.literal("Guarded"),
  name: z.string().trim().min(1),
});

const guardedDesiredStateSchema = z.object({
  domain: guardedSpecSchema.shape.domain,
  value: guardedSpecSchema.shape.value,
  secret: guardedSpecSchema.shape.secret,
});

interface GuardedEntry {
  name: string;
  domain: string;
  value: string;
  secret?: string;
}

class GuardedResource implements ResourcePort {
  readonly kind = "Guarded";
  readonly specSchema = guardedSpecSchema;
  readonly stateSchema = guardedStateSchema;
  readonly identitySchema = guardedIdentitySchema;
  readonly desiredStateSchema = guardedDesiredStateSchema;

  constructor(private readonly store: Map<string, GuardedEntry>) {}

  readonly preconditions: readonly PreconditionDeclaration[] = [
    {
      target: lockSpecSchema,
      matchOn: (sourceSpec: unknown, targetSpec: unknown) => {
        const gs = guardedSpecSchema.safeParse(sourceSpec);
        const ls = lockSpecSchema.safeParse(targetSpec);
        if (!gs.success || !ls.success) return false;
        return gs.data.domain === ls.data.domain;
      },
      guardFields: ["secret"],
      required: "absent",
    },
  ];

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      return (state as { id: string }).id;
    }
    throw new Error("Invalid state");
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = guardedSpecSchema.safeParse(spec);
    if (!parsed.success) return undefined;
    for (const [id, entry] of this.store) {
      if (entry.name === parsed.data.name) {
        const result: Record<string, unknown> = {
          id,
          name: entry.name,
          domain: entry.domain,
          value: entry.value,
        };
        if (entry.secret !== undefined) result.secret = entry.secret;
        return result;
      }
    }
    return undefined;
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = guardedSpecSchema.safeParse(spec);
    if (!parsed.success) throw new Error("Invalid spec");
    const id = `guarded-${String(Date.now())}`;
    const entry: GuardedEntry = {
      name: parsed.data.name,
      domain: parsed.data.domain,
      value: parsed.data.value,
    };
    if (parsed.data.secret !== undefined) entry.secret = parsed.data.secret;
    this.store.set(id, entry);
    const result: Record<string, unknown> = {
      id,
      name: entry.name,
      domain: entry.domain,
      value: entry.value,
    };
    if (entry.secret !== undefined) result.secret = entry.secret;
    return result;
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = guardedSpecSchema.safeParse(spec);
    if (!parsed.success) throw new Error("Invalid spec");
    const entry: GuardedEntry = {
      name: parsed.data.name,
      domain: parsed.data.domain,
      value: parsed.data.value,
    };
    if (parsed.data.secret !== undefined) entry.secret = parsed.data.secret;
    this.store.set(id, entry);
    const result: Record<string, unknown> = {
      id,
      name: entry.name,
      domain: entry.domain,
      value: entry.value,
    };
    if (entry.secret !== undefined) result.secret = entry.secret;
    return result;
  }
}

// ─── Shared store for end-to-end tests ──────────────────────────────────────
// The stores must persist between setup and update runs, so we create them
// outside the provider and inject them.

function createGuardedProvider(
  lockStore: Map<string, LockEntry>,
  guardedStore: Map<string, GuardedEntry>,
): ProviderPort {
  return {
    name: "guarded",
    configSchema: z.strictObject({}),
    async connect() {
      await Promise.resolve();
    },
    async disconnect() {
      await Promise.resolve();
    },
    supportedKinds() {
      return ["Lock", "Guarded"];
    },
    resourceHandler(kind: string, _scopes: ResolvedScopes): ResourcePort {
      if (kind === "Lock") return new LockResource(lockStore);
      if (kind === "Guarded") return new GuardedResource(guardedStore);
      throw new Error(`Unknown kind: ${kind}`);
    },
  };
}

/** Adapter that creates providers with shared stores (injected via closure). */
function guardedAdapterWithStores(
  lockStore: Map<string, LockEntry>,
  guardedStore: Map<string, GuardedEntry>,
) {
  return defineProvider("guarded", () =>
    createGuardedProvider(lockStore, guardedStore),
  );
}

// ─── End-to-end engine tests ─────────────────────────────────────────────────

describe("Convergence guards: end-to-end", () => {
  it("updates a guarded field by deleting and recreating the lock", async () => {
    // Shared stores — persist state across setup and update engine runs
    const lockStore = new Map<string, LockEntry>();
    const guardedStore = new Map<string, GuardedEntry>();
    const adapter = guardedAdapterWithStores(lockStore, guardedStore);
    const adapters = new Map([["guarded", adapter]]);
    const engine = new SyncEngine(adapters);

    // First: create both resources
    const setup = defineInfra("setup", (infra) => {
      const prov = infra.provider("g", adapter, {});
      prov.resource("Lock", "my-lock", {
        kind: "Lock",
        name: "my-lock",
        domain: "example.com",
      });
      prov.resource("Guarded", "my-guarded", {
        kind: "Guarded",
        name: "my-guarded",
        domain: "example.com",
        value: "hello",
      });
      return { outputs: {} };
    });

    const setupResult = await engine.execute(setup.toIR());
    assert.equal(setupResult.issues.length, 0);
    const lockOutcome = findOrThrow(
      setupResult.resources,
      (r) => r.name === "my-lock",
    );
    const guardedOutcome = findOrThrow(
      setupResult.resources,
      (r) => r.name === "my-guarded",
    );
    assert.equal(lockOutcome.action, "create");
    assert.equal(guardedOutcome.action, "create");

    // Now: update the guarded resource's "secret" field.
    // This should trigger the guard: lock must be deleted first.
    const update = defineInfra("update", (infra) => {
      const prov = infra.provider("g", adapter, {});
      prov.resource("Lock", "my-lock", {
        kind: "Lock",
        name: "my-lock",
        domain: "example.com",
      });
      prov.resource("Guarded", "my-guarded", {
        kind: "Guarded",
        name: "my-guarded",
        domain: "example.com",
        value: "hello",
        secret: "new-secret",
      });
      return { outputs: {} };
    });

    const updateResult = await engine.execute(update.toIR());
    assert.equal(
      updateResult.issues.length,
      0,
      `Issues: ${JSON.stringify(updateResult.issues)}`,
    );

    // The guarded resource should have been updated
    const updatedGuarded = findOrThrow(
      updateResult.resources,
      (r) => r.name === "my-guarded",
    );
    assert.equal(updatedGuarded.action, "update");
    assert.equal(updatedGuarded.status, "success");

    // The lock should be back (recreated) — it shows as no-op because
    // the engine restores it to the same spec.
    const updatedLock = findOrThrow(
      updateResult.resources,
      (r) => r.name === "my-lock",
    );
    assert.equal(updatedLock.status, "success");
  });

  it("updates a non-guarded field without touching the lock", async () => {
    // Shared stores
    const lockStore = new Map<string, LockEntry>();
    const guardedStore = new Map<string, GuardedEntry>();
    const adapter = guardedAdapterWithStores(lockStore, guardedStore);
    const adapters = new Map([["guarded", adapter]]);
    const engine = new SyncEngine(adapters);

    // Create both resources
    const setup = defineInfra("setup", (infra) => {
      const prov = infra.provider("g", adapter, {});
      prov.resource("Lock", "my-lock", {
        kind: "Lock",
        name: "my-lock",
        domain: "example.com",
      });
      prov.resource("Guarded", "my-guarded", {
        kind: "Guarded",
        name: "my-guarded",
        domain: "example.com",
        value: "hello",
      });
      return { outputs: {} };
    });
    await engine.execute(setup.toIR());

    // Update only "value" — not a guarded field
    const update = defineInfra("update", (infra) => {
      const prov = infra.provider("g", adapter, {});
      prov.resource("Lock", "my-lock", {
        kind: "Lock",
        name: "my-lock",
        domain: "example.com",
      });
      prov.resource("Guarded", "my-guarded", {
        kind: "Guarded",
        name: "my-guarded",
        domain: "example.com",
        value: "updated",
      });
      return { outputs: {} };
    });

    const result = await engine.execute(update.toIR());
    assert.equal(result.issues.length, 0);

    const guarded = findOrThrow(
      result.resources,
      (r) => r.name === "my-guarded",
    );
    assert.equal(guarded.action, "update");
    assert.equal(guarded.status, "success");

    const lock = findOrThrow(result.resources, (r) => r.name === "my-lock");
    assert.equal(lock.action, "no-op"); // Lock untouched
  });
});
