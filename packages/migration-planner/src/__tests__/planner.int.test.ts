/**
 * Integration tests for the migration planner.
 *
 * Tests the full compare() pipeline: resource matching, attribute diffing,
 * safety classification, and step generation for both directions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compare,
  PluginRegistry,
  cloudflarePlugin,
  genericPlugin,
} from "../index.js";
import type { MigrationPlan, MigrationDirection } from "../schemas.js";
import type { TerraformIR } from "@infrasync/core-ir/schemas";
import type { InfraIR } from "@infrasync/core/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(cloudflarePlugin);
  registry.register(genericPlugin);
  return registry;
}

function makeTfIR(resources: TerraformIR["resources"]): TerraformIR {
  return {
    irVersion: "1.0",
    kind: "observed_state",
    source: {
      system: "terraform",
      format: "tf_show_state_json",
      terraformVersion: "1.5.7",
      formatVersion: "1.0",
    },
    resources,
    outputs: [],
    checks: [],
    extensions: {},
  };
}

function makeTfResource(
  type: string,
  name: string,
  values: Record<string, unknown>,
): TerraformIR["resources"][number] {
  return {
    address: `${type}.${name}`,
    addressParts: {
      modulePath: [],
      mode: "managed",
      type,
      name,
    },
    provider: {
      localName: type.includes("cloudflare")
        ? "cloudflare"
        : (type.split("_")[0] ?? "unknown"),
      fullName: `registry.terraform.io/hashicorp/${type.split("_")[0] ?? "unknown"}`,
    },
    extensions: {},
    state: { values },
  };
}

function makeInfraIR(resources: InfraIR["resources"]): InfraIR {
  return {
    name: "test",
    providers:
      resources.length > 0
        ? [...new Set(resources.map((r) => r.provider))].map((p) => ({
            key: p,
            adapterName: p,
            config: {},
          }))
        : [],
    resources,
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

function plan(
  tfResources: TerraformIR["resources"],
  infraResources: InfraIR["resources"],
  direction: MigrationDirection = "tf-to-infrasync",
): MigrationPlan {
  const tfIR = makeTfIR(tfResources);
  const infraIR = makeInfraIR(infraResources);
  return compare(tfIR, infraIR, {
    direction,
    registry: makeRegistry(),
  });
}

// ─── Resource Matching ───────────────────────────────────────────────────────

test("empty IRs produce empty plan", () => {
  const result = plan([], []);
  assert.equal(result.summary.total, 0);
  assert.equal(result.steps.length, 0);
  assert.equal(result.warnings.length, 0);
});

test("identical resources → unchanged", () => {
  const result = plan(
    [
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www.example.com",
        type: "CNAME",
        value: "target.example.com",
        ttl: 300,
        proxied: true,
      }),
    ],
    [
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        zone_id: "z1",
        name: "www.example.com",
        type: "CNAME",
        value: "target.example.com",
        ttl: 300,
        proxied: true,
      }),
    ],
  );

  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.unchanged, 1);
  assert.equal(result.changes[0]?.action, "unchanged");
  assert.equal(result.steps.length, 0);
});

test("TF resource without InfraSync match → delete", () => {
  const result = plan(
    [makeTfResource("cloudflare_record", "www", { name: "www" })],
    [],
  );

  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.deletes, 1);
  const deleteChange = result.changes[0];
  assert.ok(deleteChange !== undefined);
  assert.equal(deleteChange.action, "delete");
  assert.equal(deleteChange.tfKey?.name, "www");
});

test("InfraSync resource without TF match → create", () => {
  const result = plan(
    [],
    [
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        name: "www",
      }),
    ],
  );

  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.creates, 1);
  const createChange = result.changes[0];
  assert.ok(createChange !== undefined);
  assert.equal(createChange.action, "create");
  assert.equal(createChange.infraKey?.name, "www");
});

test("TF resource with no plugin mapping → unresolvable", () => {
  const result = plan(
    [makeTfResource("custom_unknown_resource", "thing", { foo: "bar" })],
    [],
  );

  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.destructive, 1);
  assert.equal(result.changes[0]?.action, "unresolvable");
});

// ─── Attribute Diffing ───────────────────────────────────────────────────────

test("safe attribute change (ttl)", () => {
  const result = plan(
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

  assert.equal(result.summary.updates, 1);
  assert.equal(result.summary.safe, 1);

  const change = result.changes[0];
  assert.ok(change !== undefined);
  assert.equal(change.action, "update");

  const ttlDiff = change.attributeDiffs.find((d) => d.path === "spec.ttl");
  assert.ok(ttlDiff !== undefined);
  assert.equal(ttlDiff.before, 300);
  assert.equal(ttlDiff.after, 600);
  assert.equal(ttlDiff.safety, "safe");
});

test("risky attribute change (value)", () => {
  const result = plan(
    [
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "old.example.com",
        ttl: 300,
        proxied: false,
      }),
    ],
    [
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "new.example.com",
        ttl: 300,
        proxied: false,
      }),
    ],
  );

  const valueDiff = result.changes[0]?.attributeDiffs.find(
    (d) => d.path === "spec.value",
  );
  assert.ok(valueDiff !== undefined);
  assert.equal(valueDiff.safety, "risky");
});

test("destructive attribute change (type)", () => {
  const result = plan(
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

  const typeDiff = result.changes[0]?.attributeDiffs.find(
    (d) => d.path === "spec.type",
  );
  assert.ok(typeDiff !== undefined);
  assert.equal(typeDiff.safety, "destructive");

  assert.equal(result.changes[0]?.safety, "destructive");
});

test("destructive attribute change (zone_id)", () => {
  const result = plan(
    [
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "A",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ],
    [
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        zone_id: "z2",
        name: "www",
        type: "A",
        value: "1.2.3.4",
        ttl: 300,
        proxied: false,
      }),
    ],
  );

  assert.equal(result.changes[0]?.safety, "destructive");
});

test("multiple attribute changes — worst safety wins", () => {
  const result = plan(
    [
      makeTfResource("cloudflare_record", "www", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "old.example.com",
        ttl: 300,
        proxied: false,
      }),
    ],
    [
      makeInfraResource("CloudflareRecord", "www", "cloudflare", {
        zone_id: "z1",
        name: "www",
        type: "CNAME",
        value: "new.example.com",
        ttl: 600,
        proxied: true,
      }),
    ],
  );

  // ttl=safe, value=risky, proxied=safe → worst is risky
  assert.equal(result.changes[0]?.safety, "risky");
});

// ─── Step Generation ─────────────────────────────────────────────────────────

test("create step targets correct system (tf-to-infrasync)", () => {
  const result = plan(
    [],
    [
      makeInfraResource("CloudflareRecord", "api", "cloudflare", {
        name: "api",
      }),
    ],
    "tf-to-infrasync",
  );

  // create step + verify step
  assert.equal(result.steps.length, 2);
  const step = result.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.action, "create");
  assert.equal(step.target, "infrasync");
  assert.equal(step.resourceName, "api");
  assert.equal(step.requiresConfirmation, false);
});

test("create step targets correct system (infrasync-to-tf)", () => {
  const result = plan(
    [],
    [
      makeInfraResource("CloudflareRecord", "api", "cloudflare", {
        name: "api",
      }),
    ],
    "infrasync-to-tf",
  );

  const step = result.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.action, "create");
  assert.equal(step.target, "terraform");
});

test("delete step targets source system", () => {
  const result = plan(
    [makeTfResource("cloudflare_record", "www", { name: "www" })],
    [],
    "tf-to-infrasync",
  );

  const step = result.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.action, "delete");
  assert.equal(step.target, "terraform");
});

test("destructive changes → manual-intervention step", () => {
  const result = plan(
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

  const manualStep = result.steps.find(
    (s) => s.action === "manual-intervention",
  );
  assert.ok(manualStep !== undefined);
  assert.equal(manualStep.requiresConfirmation, true);
  assert.ok(manualStep.description.includes("Destructive changes"));
});

test("update steps include verify steps", () => {
  const result = plan(
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

  const verifyStep = result.steps.find((s) => s.action === "verify");
  assert.ok(verifyStep !== undefined);
  assert.ok(verifyStep.id.endsWith("-verify"));
  assert.ok(verifyStep.dependsOn.includes("step-0"));
});

test("steps are ordered: creates → updates → deletes → manual → verify", () => {
  const result = plan(
    [
      makeTfResource("cloudflare_record", "delete-me", {
        zone_id: "z1",
        name: "delete-me",
        type: "A",
        value: "1.1.1.1",
        ttl: 300,
        proxied: false,
      }),
      makeTfResource("cloudflare_record", "update-me", {
        zone_id: "z1",
        name: "update-me",
        type: "CNAME",
        value: "old.example.com",
        ttl: 300,
        proxied: false,
      }),
    ],
    [
      makeInfraResource("CloudflareRecord", "update-me", "cloudflare", {
        zone_id: "z1",
        name: "update-me",
        type: "CNAME",
        value: "new.example.com",
        ttl: 300,
        proxied: false,
      }),
      makeInfraResource("CloudflareRecord", "create-me", "cloudflare", {
        zone_id: "z1",
        name: "create-me",
        type: "A",
        value: "2.2.2.2",
        ttl: 300,
        proxied: false,
      }),
    ],
  );

  const actions = result.steps.map((s) => s.action);
  const firstCreate = actions.indexOf("create");
  const firstUpdate = actions.indexOf("update");
  const firstDelete = actions.indexOf("delete");
  const firstVerify = actions.indexOf("verify");

  // Verify ordering constraints
  if (firstCreate >= 0 && firstUpdate >= 0) {
    assert.ok(firstCreate < firstUpdate, "creates before updates");
  }
  if (firstUpdate >= 0 && firstDelete >= 0) {
    assert.ok(firstUpdate < firstDelete, "updates before deletes");
  }
  if (firstDelete >= 0 && firstVerify >= 0) {
    assert.ok(firstDelete < firstVerify, "deletes before verify");
  }
});

// ─── Bidirectionality ────────────────────────────────────────────────────────

test("infrasync-to-tf direction produces correct targets", () => {
  const result = plan(
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
    "infrasync-to-tf",
  );

  const updateStep = result.steps.find((s) => s.action === "update");
  assert.ok(updateStep !== undefined);
  assert.equal(updateStep.target, "terraform");
});

test("infrasync-to-tf create targets terraform", () => {
  const result = plan(
    [],
    [
      makeInfraResource("CloudflareRecord", "new", "cloudflare", {
        name: "new",
      }),
    ],
    "infrasync-to-tf",
  );

  assert.equal(result.steps[0]?.target, "terraform");
});

// ─── Multi-Resource ──────────────────────────────────────────────────────────

test("mixed create/update/delete in single plan", () => {
  const result = plan(
    [
      makeTfResource("cloudflare_record", "existing", {
        zone_id: "z1",
        name: "existing",
        type: "A",
        value: "1.1.1.1",
        ttl: 300,
        proxied: false,
      }),
      makeTfResource("cloudflare_record", "delete-me", {
        zone_id: "z1",
        name: "delete-me",
        type: "A",
        value: "2.2.2.2",
        ttl: 300,
        proxied: false,
      }),
    ],
    [
      makeInfraResource("CloudflareRecord", "existing", "cloudflare", {
        zone_id: "z1",
        name: "existing",
        type: "A",
        value: "1.1.1.1",
        ttl: 600,
        proxied: false,
      }),
      makeInfraResource("CloudflareRecord", "create-me", "cloudflare", {
        zone_id: "z1",
        name: "create-me",
        type: "A",
        value: "3.3.3.3",
        ttl: 300,
        proxied: false,
      }),
    ],
  );

  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.creates, 1);
  assert.equal(result.summary.deletes, 1);
  assert.equal(result.summary.updates, 1);
  assert.equal(result.summary.safe, 2); // create + update(ttl)
  assert.equal(result.summary.risky, 1); // delete
});

// ─── Warnings ────────────────────────────────────────────────────────────────

test("warns when unresolvable resources exist", () => {
  const result = plan(
    [makeTfResource("custom_resource", "thing", { foo: "bar" })],
    [],
  );

  assert.ok(result.warnings.some((w) => w.includes("not be matched")));
});

test("warns when destructive changes exist", () => {
  const result = plan(
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

  assert.ok(result.warnings.some((w) => w.includes("destructive")));
});

// ─── Plugin Registry ─────────────────────────────────────────────────────────

test("plugin registry resolves mappings", () => {
  const registry = makeRegistry();
  assert.equal(
    registry.resolveInfraKind("cloudflare_record"),
    "CloudflareRecord",
  );
  assert.equal(registry.resolveTfType("CloudflareRecord"), "cloudflare_record");
  assert.equal(registry.resolveInfraKind("unknown_type"), undefined);
});

test("plugin registry rejects duplicate adapter names", () => {
  const registry = new PluginRegistry();
  registry.register(cloudflarePlugin);
  assert.throws(() => {
    registry.register({ ...cloudflarePlugin, name: "other" });
  }, /already registered/);
});

test("plugin registry allows re-registration of same plugin", () => {
  const registry = new PluginRegistry();
  registry.register(cloudflarePlugin);
  // Same name + adapter — idempotent
  registry.register(cloudflarePlugin);
  assert.equal(registry.get("cloudflare")?.name, "cloudflare");
});
