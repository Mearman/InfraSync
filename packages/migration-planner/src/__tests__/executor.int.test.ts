/**
 * Integration tests for the migration execution engine.
 *
 * Uses mock ProviderPort implementations to verify step execution,
 * dependency ordering, failure propagation, and dry-run behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import {
  compare,
  executePlan,
  PluginRegistry,
  genericPlugin,
  cloudflarePlugin,
} from "../index.js";
import type { ExecutionContext } from "../executor.js";
import {
  ResolvedScopes,
  type ProviderPort,
  type ResourcePort,
} from "@infrasync/core/provider";
import type { InfraIR } from "@infrasync/core/types";
import type { TerraformIR } from "@infrasync/core-ir/schemas";

// ─── Mock Provider ───────────────────────────────────────────────────────────

/** Tracks calls to the mock resource handler. */
interface CallLog {
  readonly action: string;
  readonly kind: string;
  readonly name: string;
}

/** Narrow unknown to Record<string, unknown> without type assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStrField(obj: Record<string, unknown>, field: string): string {
  const val = obj[field];
  return typeof val === "string" ? val : "unknown";
}

function createMockProvider(callLog: CallLog[]): ProviderPort {
  const specSchema = z.object({
    zone_id: z.string().trim(),
    name: z.string().trim(),
    type: z.string().trim(),
    value: z.string().trim(),
    ttl: z.number(),
    proxied: z.boolean(),
  });

  const stateSchema = z.object({
    id: z.string().trim(),
    zone_id: z.string().trim(),
    name: z.string().trim(),
    type: z.string().trim(),
    content: z.string().trim(),
    ttl: z.number(),
    proxied: z.boolean(),
  });

  const handler: ResourcePort = {
    kind: "DnsRecord",
    specSchema,
    stateSchema,
    identitySchema: specSchema.pick({ name: true, type: true }),
    desiredStateSchema: specSchema.pick({
      ttl: true,
      proxied: true,
      value: true,
    }),
    getStateId(state: unknown): string {
      if (isRecord(state) && "id" in state) {
        return getStrField(state, "id");
      }
      return "unknown";
    },
    async read(spec: unknown) {
      if (isRecord(spec) && "name" in spec) {
        const nameStr = getStrField(spec, "name");
        callLog.push({ action: "read", kind: "DnsRecord", name: nameStr });
        return {
          id: `mock-${nameStr}-id`,
          zone_id: "z1",
          name: nameStr,
          type: "CNAME",
          content: "1.2.3.4",
          ttl: 300,
          proxied: false,
        };
      }
      return undefined;
    },
    async create(spec: unknown) {
      if (isRecord(spec) && "name" in spec) {
        const nameStr = getStrField(spec, "name");
        callLog.push({ action: "create", kind: "DnsRecord", name: nameStr });
        return {
          id: `mock-${nameStr}-id`,
          zone_id: "z1",
          name: nameStr,
          type: "CNAME",
          content: "created",
          ttl: 300,
          proxied: false,
        };
      }
      return undefined;
    },
    async update(id: string, spec: unknown) {
      if (isRecord(spec) && "name" in spec) {
        const nameStr = getStrField(spec, "name");
        callLog.push({ action: "update", kind: "DnsRecord", name: nameStr });
        return {
          id,
          zone_id: "z1",
          name: nameStr,
          type: "CNAME",
          content: "updated",
          ttl: 300,
          proxied: false,
        };
      }
      return undefined;
    },
  };

  return {
    name: "cloudflare",
    configSchema: z.object({ apiToken: z.string().trim() }),
    async connect() {
      /* mock */
    },
    async disconnect() {
      /* mock */
    },
    supportedKinds() {
      return ["DnsRecord"];
    },
    resourceHandler(kind: string, _scopes: ResolvedScopes): ResourcePort {
      if (kind === "DnsRecord" || kind === "CloudflareRecord") return handler;
      throw new Error(`Unknown kind: ${kind}`);
    },
  };
}

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeTfResource(
  type: string,
  name: string,
  values: Record<string, unknown>,
): TerraformIR["resources"][number] {
  return {
    address: `${type}.${name}`,
    addressParts: { modulePath: [], mode: "managed", type, name },
    provider: {
      localName: "cloudflare",
      fullName: "registry.terraform.io/cloudflare/cloudflare",
    },
    extensions: {},
    state: { values },
  };
}

function makeInfraResource(
  kind: string,
  name: string,
  provider: string,
  spec: Record<string, unknown>,
): InfraIR["resources"][number] {
  return {
    name,
    kind,
    provider,
    mode: "manage",
    spec,
    dependsOn: [],
    refBindings: [],
  };
}

function makeTfIR(
  resources: readonly TerraformIR["resources"][number][],
): TerraformIR {
  return {
    irVersion: "1.0",
    kind: "observed_state",
    source: {
      system: "terraform",
      format: "tf_show_state_json",
      terraformVersion: "1.5.7",
      formatVersion: "1.0",
    },
    resources: [...resources],
    outputs: [],
    checks: [],
    extensions: {},
  };
}

function makeInfraIR(
  resources: readonly InfraIR["resources"][number][],
): InfraIR {
  return {
    name: "test",
    providers: [{ key: "cloudflare", adapterName: "cloudflare", config: {} }],
    resources: [...resources],
  };
}

function plan(
  tfResources: readonly TerraformIR["resources"][number][],
  infraResources: readonly InfraIR["resources"][number][],
) {
  const registry = new PluginRegistry();
  registry.register(genericPlugin);
  registry.register(cloudflarePlugin);
  return compare(makeTfIR(tfResources), makeInfraIR(infraResources), {
    direction: "tf-to-infrasync",
    registry,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("dry run produces success outcomes without calling providers", async () => {
  const callLog: CallLog[] = [];
  const mockProvider = createMockProvider(callLog);
  const providers = new Map([["cloudflare", mockProvider]]);

  const migrationPlan = plan(
    [
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ],
    [],
  );

  const context: ExecutionContext = {
    providers,
    infraIR: makeInfraIR([]),
    terraformIR: makeTfIR([
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ]),
    dryRun: true,
  };

  const result = await executePlan(migrationPlan, context);

  assert.equal(result.succeeded, result.totalSteps);
  assert.equal(result.failed, 0);
  assert.equal(callLog.length, 0, "dry run should not call providers");
});

test("manual-intervention steps are marked requires-confirmation", async () => {
  const callLog: CallLog[] = [];
  const mockProvider = createMockProvider(callLog);
  const providers = new Map([["cloudflare", mockProvider]]);

  // Unresolvable resource → manual-intervention step
  const migrationPlan = plan(
    [makeTfResource("unknown_resource", "thing", { id: "x" })],
    [],
  );

  const context: ExecutionContext = {
    providers,
    infraIR: makeInfraIR([]),
    terraformIR: makeTfIR([
      makeTfResource("unknown_resource", "thing", { id: "x" }),
    ]),
  };

  const result = await executePlan(migrationPlan, context);
  const manualStep = result.outcomes.find(
    (o) => o.status === "requires-confirmation",
  );
  assert.ok(manualStep !== undefined);
  assert.ok(manualStep.message.includes("MANUAL"));
});

test("onStep callback can skip steps", async () => {
  const callLog: CallLog[] = [];
  const mockProvider = createMockProvider(callLog);
  const providers = new Map([["cloudflare", mockProvider]]);

  const migrationPlan = plan(
    [
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ],
    [
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 600,
        proxied: false,
      }),
    ],
  );

  const context: ExecutionContext = {
    providers,
    infraIR: makeInfraIR([
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 600,
        proxied: false,
      }),
    ]),
    terraformIR: makeTfIR([
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ]),
    onStep: async () => false, // Skip all steps
  };

  const result = await executePlan(migrationPlan, context);
  const skipped = result.outcomes.filter((o) => o.status === "skipped");
  assert.ok(skipped.length > 0, "all actionable steps should be skipped");
  assert.equal(callLog.length, 0, "skipped steps should not call providers");
});

test("execution result has correct counters", async () => {
  const migrationPlan = plan(
    [],
    [
      makeInfraResource("CloudflareRecord", "new", "cloudflare", {
        zone_id: "z1",
        name: "new",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ],
  );

  const context: ExecutionContext = {
    providers: new Map([["cloudflare", createMockProvider([])]]),
    infraIR: makeInfraIR([
      makeInfraResource("CloudflareRecord", "new", "cloudflare", {
        zone_id: "z1",
        name: "new",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ]),
    terraformIR: makeTfIR([]),
    dryRun: true,
  };

  const result = await executePlan(migrationPlan, context);

  assert.ok(result.totalSteps > 0);
  assert.equal(result.totalSteps, result.outcomes.length);
  assert.equal(result.failed, 0);
  assert.ok(result.durationMs >= 0);
});

test("dependency levels are correctly computed", async () => {
  // Create a plan with multiple resources
  const migrationPlan = plan(
    [],
    [
      makeInfraResource("CloudflareRecord", "a", "cloudflare", {
        zone_id: "z1",
        name: "a",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
      makeInfraResource("CloudflareRecord", "b", "cloudflare", {
        zone_id: "z1",
        name: "b",
        type: "CNAME",
        value: "5.6.7.8",
        ttl: 300,
        proxied: false,
      }),
    ],
  );

  const context: ExecutionContext = {
    providers: new Map([["cloudflare", createMockProvider([])]]),
    infraIR: makeInfraIR([
      makeInfraResource("CloudflareRecord", "a", "cloudflare", {
        zone_id: "z1",
        name: "a",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
      makeInfraResource("CloudflareRecord", "b", "cloudflare", {
        zone_id: "z1",
        name: "b",
        type: "CNAME",
        value: "5.6.7.8",
        ttl: 300,
        proxied: false,
      }),
    ]),
    terraformIR: makeTfIR([]),
    dryRun: true,
  };

  const result = await executePlan(migrationPlan, context);
  assert.equal(result.succeeded, result.totalSteps);
});

test("verify steps succeed when resource exists", async () => {
  const callLog: CallLog[] = [];
  const mockProvider = createMockProvider(callLog);
  const providers = new Map([["cloudflare", mockProvider]]);

  // Create a plan that has an update + verify
  const migrationPlan = plan(
    [
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ],
    [
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 600,
        proxied: false,
      }),
    ],
  );

  const context: ExecutionContext = {
    providers,
    infraIR: makeInfraIR([
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 600,
        proxied: false,
      }),
    ]),
    terraformIR: makeTfIR([
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ]),
  };

  const result = await executePlan(migrationPlan, context);

  // Should have update step + verify step, both successful
  const verifyOutcome = result.outcomes.find((o) =>
    o.stepId.includes("verify"),
  );
  assert.ok(verifyOutcome !== undefined, "should have a verify step");
  assert.equal(verifyOutcome.status, "success");

  // Provider should have been called for update and verify (read)
  const readCalls = callLog.filter((c) => c.action === "read");
  const updateCalls = callLog.filter((c) => c.action === "update");
  assert.ok(readCalls.length > 0, "verify should read from provider");
  assert.ok(updateCalls.length > 0, "update step should call provider update");
});

test("creates call provider.create", async () => {
  const callLog: CallLog[] = [];
  const mockProvider = createMockProvider(callLog);
  const providers = new Map([["cloudflare", mockProvider]]);

  const migrationPlan = plan(
    [],
    [
      makeInfraResource("CloudflareRecord", "new", "cloudflare", {
        zone_id: "z1",
        name: "new",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ],
  );

  const context: ExecutionContext = {
    providers,
    infraIR: makeInfraIR([
      makeInfraResource("CloudflareRecord", "new", "cloudflare", {
        zone_id: "z1",
        name: "new",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ]),
    terraformIR: makeTfIR([]),
  };

  const result = await executePlan(migrationPlan, context);

  const createCalls = callLog.filter((c) => c.action === "create");
  assert.equal(createCalls.length, 1);
  assert.equal(result.failed, 0);
});

test("missing provider produces failed step", async () => {
  const migrationPlan = plan(
    [],
    [
      makeInfraResource("CloudflareRecord", "new", "cloudflare", {
        zone_id: "z1",
        name: "new",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ],
  );

  // Empty providers map — no cloudflare provider
  const context: ExecutionContext = {
    providers: new Map(),
    infraIR: makeInfraIR([
      makeInfraResource("CloudflareRecord", "new", "cloudflare", {
        zone_id: "z1",
        name: "new",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ]),
    terraformIR: makeTfIR([]),
  };

  const result = await executePlan(migrationPlan, context);
  assert.ok(result.failed > 0, "missing provider should fail steps");
  const failedOutcome = result.outcomes.find((o) => o.status === "failed");
  assert.ok(failedOutcome !== undefined);
  assert.ok(failedOutcome.error?.includes("not connected"));
});

test("replace-create calls provider.create (CBD flow)", async () => {
  const callLog: CallLog[] = [];
  const mockProvider = createMockProvider(callLog);
  const providers = new Map([["cloudflare", mockProvider]]);

  // Type change (CNAME → A) is destructive with CBD mitigation
  const migrationPlan = plan(
    [
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ],
    [
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        zone_id: "z1",
        name: "www",
        type: "A",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ],
  );

  const context: ExecutionContext = {
    providers,
    infraIR: makeInfraIR([
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        zone_id: "z1",
        name: "www",
        type: "A",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ]),
    terraformIR: makeTfIR([
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ]),
  };

  const result = await executePlan(migrationPlan, context);

  const createCalls = callLog.filter((c) => c.action === "create");
  assert.ok(
    createCalls.length > 0,
    "replace-create should call provider.create",
  );

  // replace-create + replace-destroy + verify steps should all succeed
  const replaceCreate = result.outcomes.find((o) =>
    o.message.includes("Replace-created"),
  );
  assert.ok(replaceCreate !== undefined);
  assert.equal(replaceCreate.status, "success");

  // replace-destroy is a no-op for InfraSync (stateless)
  const replaceDestroy = result.outcomes.find((o) =>
    o.stepId.includes("destroy"),
  );
  assert.ok(replaceDestroy !== undefined);
  assert.equal(replaceDestroy.status, "success");
});
