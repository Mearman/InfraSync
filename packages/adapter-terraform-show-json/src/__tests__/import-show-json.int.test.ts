/**
 * Integration tests for the TF-Show JSON import adapter.
 *
 * Tests importStateJson() and importPlanJson() against realistic fixture
 * files, verifying structural correctness of the output TerraformIR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { importStateJson, importPlanJson } from "../import-show-json.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

// ─── State import fixtures ───────────────────────────────────────────────────

test("state: minimal — single resource, no outputs", async () => {
  const raw = await readFile(
    join(FIXTURES_DIR, "state", "minimal.json"),
    "utf-8",
  );
  const result = importStateJson(raw);
  const ir = result.document;

  assert.equal(ir.irVersion, "1.0");
  assert.equal(ir.kind, "observed_state");
  assert.equal(ir.source.format, "tf_show_state_json");
  assert.equal(ir.source.formatVersion, "1.0");
  assert.equal(ir.source.terraformVersion, "1.5.7");
  assert.equal(ir.resources.length, 1);
  assert.equal(ir.outputs.length, 0);
  assert.equal(ir.checks.length, 0);

  const resource = ir.resources[0];
  assert.ok(resource !== undefined);
  assert.equal(resource.address, "cloudflare_record.www");
  assert.equal(resource.addressParts.mode, "managed");
  assert.equal(resource.addressParts.type, "cloudflare_record");
  assert.equal(resource.addressParts.name, "www");
  assert.equal(resource.provider.localName, "cloudflare");
  assert.equal(resource.state?.values.zone_id, "abc123");

  assert.equal(result.fidelity.issues.length, 0);
});

test("state: full — multiple providers, data source, child module, outputs", async () => {
  const raw = await readFile(join(FIXTURES_DIR, "state", "full.json"), "utf-8");
  const result = importStateJson(raw);
  const ir = result.document;

  assert.equal(ir.resources.length, 4);
  assert.equal(ir.outputs.length, 2);

  // Outputs
  const endpoint = ir.outputs.find((o) => o.name === "endpoint");
  assert.ok(endpoint !== undefined);
  assert.equal(endpoint.value, "https://app.example.com");
  assert.equal(endpoint.sensitive, false);

  const secretKey = ir.outputs.find((o) => o.name === "secret_key");
  assert.ok(secretKey !== undefined);
  assert.equal(secretKey.sensitive, true);

  // Resources: verify all addresses present
  const addresses = ir.resources.map((r) => r.address);
  assert.ok(addresses.includes("cloudflare_record.www"));
  assert.ok(addresses.includes("aws_s3_bucket.logs"));
  assert.ok(addresses.includes("data.aws_ami.ubuntu"));
  assert.ok(addresses.includes("module.networking.aws_vpc.main"));

  // Data source parsed correctly
  const dataSource = ir.resources.find(
    (r) => r.address === "data.aws_ami.ubuntu",
  );
  assert.ok(dataSource !== undefined);
  assert.equal(dataSource.addressParts.mode, "data");

  // Child module resource has correct module path
  const vpc = ir.resources.find(
    (r) => r.address === "module.networking.aws_vpc.main",
  );
  assert.ok(vpc !== undefined);
  assert.deepEqual(vpc.addressParts.modulePath, ["networking"]);

  // Provider names
  assert.equal(
    ir.resources.find((r) => r.address === "cloudflare_record.www")?.provider
      .localName,
    "cloudflare",
  );
  assert.equal(
    ir.resources.find((r) => r.address === "aws_s3_bucket.logs")?.provider
      .localName,
    "aws",
  );
});

test("state: rejects unsupported major version", () => {
  const raw = JSON.stringify({
    format_version: "2.0",
    values: { root_module: {} },
  });
  assert.throws(() => importStateJson(raw), /Unsupported state format_version/);
});

test("state: warns on unknown minor version", () => {
  const raw = JSON.stringify({
    format_version: "1.99",
    values: { root_module: {} },
  });
  const result = importStateJson(raw);
  assert.ok(result.fidelity.issues.length >= 1);
  assert.ok(
    result.fidelity.issues.some((issue) =>
      issue.message.includes("Unknown state format_version"),
    ),
  );
});

// ─── Plan import fixtures ────────────────────────────────────────────────────

test("plan: create — single resource with change overlay", async () => {
  const raw = await readFile(
    join(FIXTURES_DIR, "plan", "create.json"),
    "utf-8",
  );
  const result = importPlanJson(raw);
  const ir = result.document;

  assert.equal(ir.kind, "planned_change");
  assert.equal(ir.source.format, "tf_show_plan_json");
  assert.equal(ir.resources.length, 1);

  const resource = ir.resources[0];
  assert.ok(resource !== undefined);
  assert.equal(resource.address, "cloudflare_record.www");
  assert.ok(resource.change !== undefined);
  assert.deepEqual(resource.change.change.actions, ["create"]);
  assert.equal(resource.change.change.actionReason, "config_drift");
});

test("plan: update with checks — multiple changes and check results", async () => {
  const raw = await readFile(
    join(FIXTURES_DIR, "plan", "update-with-checks.json"),
    "utf-8",
  );
  const result = importPlanJson(raw);
  const ir = result.document;

  assert.equal(ir.resources.length, 2);

  // Updated resource
  const bucket = ir.resources.find((r) => r.address === "aws_s3_bucket.app");
  assert.ok(bucket !== undefined);
  assert.ok(bucket.change !== undefined);
  assert.deepEqual(bucket.change.change.actions, ["update"]);
  assert.ok(bucket.change.change.replacePaths !== undefined);

  // No-op resource
  const policy = ir.resources.find(
    (r) => r.address === "aws_s3_bucket_policy.app",
  );
  assert.ok(policy !== undefined);
  assert.ok(policy.change !== undefined);
  assert.deepEqual(policy.change.change.actions, ["no-op"]);

  assert.equal(ir.outputs.length, 1);
  const output = ir.outputs[0];
  assert.ok(output !== undefined);
  assert.equal(output.name, "bucket_arn");

  // Check
  assert.equal(ir.checks.length, 1);
  const check = ir.checks[0];
  assert.ok(check !== undefined);
  assert.equal(check.address, "check.bucket_compliance.versioning");
  assert.equal(check.status, "pass");
  assert.equal(check.message, "Versioning is enabled");
});

test("plan: rejects unsupported major version", () => {
  const raw = JSON.stringify({
    format_version: "3.0",
    planned_values: { root_module: {} },
  });
  assert.throws(() => importPlanJson(raw), /Unsupported plan format_version/);
});

// ─── Schema validation at boundary ───────────────────────────────────────────

test("state: rejects malformed JSON", () => {
  assert.throws(() => importStateJson("not json"), SyntaxError);
});

test("plan: rejects malformed JSON", () => {
  assert.throws(() => importPlanJson("{bad"), SyntaxError);
});

test("state: rejects invalid envelope shape", () => {
  const raw = JSON.stringify({ wrong: true });
  assert.throws(() => importStateJson(raw));
});

test("plan: rejects invalid envelope shape", () => {
  const raw = JSON.stringify({ wrong: true });
  assert.throws(() => importPlanJson(raw));
});
