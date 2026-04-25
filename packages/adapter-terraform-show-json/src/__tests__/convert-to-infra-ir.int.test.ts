/**
 * Integration tests for TerraformIR → InfraIR bridge.
 *
 * Tests the `convertToInfraIR()` function that bridges the analysis lane
 * (TF-Show import) into the InfraSync management pipeline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { importStateJson } from "../import-show-json.js";
import { convertToInfraIR } from "../convert-to-infra-ir.js";

// ─── Minimal state fixture ───────────────────────────────────────────────────

const MINIMAL_STATE = JSON.stringify({
  format_version: "1.0",
  terraform_version: "1.5.7",
  values: {
    outputs: {},
    root_module: {
      resources: [
        {
          address: "cloudflare_record.www",
          mode: "managed",
          type: "cloudflare_record",
          name: "www",
          provider_name: "cloudflare",
          schema_version: 2,
          values: {
            zone_id: "abc123",
            name: "www.example.com",
            type: "CNAME",
            value: "target.example.com",
            ttl: 300,
            proxied: true,
          },
          sensitive_values: {},
        },
      ],
    },
  },
});

// ─── Multi-provider fixture ──────────────────────────────────────────────────

const MULTI_PROVIDER_STATE = JSON.stringify({
  format_version: "1.0",
  terraform_version: "1.5.7",
  values: {
    outputs: {},
    root_module: {
      resources: [
        {
          address: "cloudflare_record.api",
          mode: "managed",
          type: "cloudflare_record",
          name: "api",
          provider_name: "cloudflare",
          schema_version: 2,
          values: {
            zone_id: "zone-1",
            name: "api.example.com",
            type: "A",
            value: "1.2.3.4",
            ttl: 300,
            proxied: false,
          },
          sensitive_values: {},
        },
        {
          address: "aws_s3_bucket.logs",
          mode: "managed",
          type: "aws_s3_bucket",
          name: "logs",
          provider_name: "registry.terraform.io/hashicorp/aws",
          schema_version: 0,
          values: {
            bucket: "my-logs-bucket",
            region: "us-east-1",
          },
          sensitive_values: {},
        },
        {
          address: "data.aws_ami.ubuntu",
          mode: "data",
          type: "aws_ami",
          name: "ubuntu",
          provider_name: "registry.terraform.io/hashicorp/aws",
          schema_version: 0,
          values: {
            most_recent: true,
            owners: ["099720109477"],
          },
          sensitive_values: {},
        },
      ],
    },
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function importStateAndConvert(raw: string) {
  const stateResult = importStateJson(raw);
  return convertToInfraIR(stateResult.document, { name: "test" });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("converts minimal state to InfraIR", () => {
  const result = importStateAndConvert(MINIMAL_STATE);
  const { document } = result;

  assert.equal(document.name, "test");
  assert.equal(document.providers.length, 1);
  assert.equal(document.providers[0]?.adapterName, "cloudflare");
  assert.equal(document.resources.length, 1);

  const resource = document.resources[0];
  assert.ok(resource !== undefined);
  assert.equal(resource.name, "www");
  assert.equal(resource.provider, "cloudflare");
  assert.equal(resource.kind, "CloudflareRecord");
  assert.equal(resource.mode, "manage");

  // Spec should contain the state values
  assert.equal(resource.spec.zone_id, "abc123");
  assert.equal(resource.spec.name, "www.example.com");
  assert.equal(resource.spec.type, "CNAME");
  assert.equal(resource.spec.value, "target.example.com");
  assert.equal(resource.spec.ttl, 300);
  assert.equal(resource.spec.proxied, true);
});

test("maps provider local names to adapter names", () => {
  const result = importStateAndConvert(MINIMAL_STATE);
  const provider = result.document.providers[0];
  assert.ok(provider !== undefined);
  assert.equal(provider.key, "cloudflare");
  assert.equal(provider.adapterName, "cloudflare");
});

test("maps multi-provider state correctly", () => {
  const result = importStateAndConvert(MULTI_PROVIDER_STATE);
  const { document } = result;

  assert.equal(document.providers.length, 2);
  const adapterNames = document.providers.map((p) => p.adapterName).sort();
  assert.ok(adapterNames.includes("aws"));
  assert.ok(adapterNames.includes("cloudflare"));

  assert.equal(document.resources.length, 3);

  // Managed resource (cloudflare)
  const cfRecord = document.resources.find((r) => r.name === "api");
  assert.ok(cfRecord !== undefined);
  assert.equal(cfRecord.kind, "CloudflareRecord");
  assert.equal(cfRecord.mode, "manage");

  // Managed resource (aws)
  const bucket = document.resources.find((r) => r.name === "logs");
  assert.ok(bucket !== undefined);
  assert.equal(bucket.kind, "AwsS3Bucket");
  assert.equal(bucket.mode, "manage");

  // Data source → read mode
  const ami = document.resources.find((r) => r.name === "data_ubuntu");
  assert.ok(ami !== undefined);
  assert.equal(ami.kind, "AwsAmi");
  assert.equal(ami.mode, "read");
});

test("data sources get data_ prefix and read mode", () => {
  const result = importStateAndConvert(MULTI_PROVIDER_STATE);
  const dataResources = result.document.resources.filter(
    (r) => r.mode === "read",
  );
  assert.equal(dataResources.length, 1);
  assert.ok(dataResources[0]?.name.startsWith("data_"));

  const managed = result.document.resources.filter((r) => r.mode === "manage");
  assert.equal(managed.length, 2);
  for (const r of managed) {
    assert.ok(!r.name.startsWith("data_"));
  }
});

test("converts snake_case types to PascalCase kinds", () => {
  const result = importStateAndConvert(MULTI_PROVIDER_STATE);
  const kinds = result.document.resources.map((r) => r.kind);

  assert.ok(kinds.includes("CloudflareRecord"));
  assert.ok(kinds.includes("AwsS3Bucket"));
  assert.ok(kinds.includes("AwsAmi"));
});

test("preserves state values as spec when no config", () => {
  const result = importStateAndConvert(MINIMAL_STATE);
  const resource = result.document.resources[0];
  assert.ok(resource !== undefined);

  // State values become the spec (desired config)
  assert.equal(resource.spec.zone_id, "abc123");
  assert.equal(resource.spec.proxied, true);
  assert.equal(resource.spec.ttl, 300);
});

test("reports fidelity for unknown providers", () => {
  const unknownState = JSON.stringify({
    format_version: "1.0",
    terraform_version: "1.5.7",
    values: {
      outputs: {},
      root_module: {
        resources: [
          {
            address: "custom_resource.thing",
            mode: "managed",
            type: "custom_resource",
            name: "thing",
            provider_name: "registry.terraform.io/example/custom",
            schema_version: 0,
            values: { foo: "bar" },
            sensitive_values: {},
          },
        ],
      },
    },
  });

  const result = importStateAndConvert(unknownState);
  const lossyIssues = result.fidelity.issues.filter(
    (i) => i.class === "lossy" && i.path.startsWith("provider."),
  );
  assert.ok(lossyIssues.length > 0, "Should report unknown provider as lossy");

  const provider = result.document.providers[0];
  assert.ok(provider !== undefined);
  assert.equal(provider.adapterName, "custom");
});

test("produces valid InfraIR (passes schema validation)", () => {
  const result = importStateAndConvert(MULTI_PROVIDER_STATE);
  // convertToInfraIR calls infraIRSchema.parse() internally — if we got here, it's valid
  assert.equal(result.document.providers.length, 2);
  assert.equal(result.document.resources.length, 3);
});

test("handles empty state", () => {
  const emptyState = JSON.stringify({
    format_version: "1.0",
    terraform_version: "1.5.7",
    values: {
      outputs: {},
      root_module: {
        resources: [],
      },
    },
  });

  const result = importStateAndConvert(emptyState);
  assert.equal(result.document.providers.length, 0);
  assert.equal(result.document.resources.length, 0);
  assert.equal(result.fidelity.overall, "lossless");
});
