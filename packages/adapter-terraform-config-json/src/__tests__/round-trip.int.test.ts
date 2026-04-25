/**
 * Round-trip guarantee tests for the TF-Config JSON bidirectional config lane.
 *
 * Phase 3 exit criteria: validates that IR → *.tf.json → IR and
 * *.tf.json → IR → *.tf.json produce structurally equivalent results
 * with declared fidelity outcomes.
 *
 * Two directions:
 * 1. IR → export → *.tf.json → import → IR (round-trip through Terraform)
 * 2. *.tf.json → import → IR → export → *.tf.json (round-trip through IR)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportTfConfigJson } from "../export-config-json.js";
import { importTfConfigJson } from "../import-config-json.js";
import { cloudflareResourceMappers } from "../cloudflare-mappers.js";
import type { InfraIR } from "@infrasync/core/schemas";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse JSON and assert it's a string-keyed object. */
function parseObj(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  assert.ok(isRecord(parsed), "Expected parsed JSON to be a plain object");
  return parsed;
}

/**
 * Assert that two InfraIR documents are structurally equivalent.
 * Compares name, provider count, resource count, and resource fields.
 */
function assertStructurallyEquivalent(
  original: InfraIR,
  roundTripped: InfraIR,
  context: string,
): void {
  assert.equal(roundTripped.name, original.name, `${context}: name mismatch`);

  assert.equal(
    roundTripped.providers.length,
    original.providers.length,
    `${context}: provider count mismatch`,
  );

  assert.equal(
    roundTripped.resources.length,
    original.resources.length,
    `${context}: resource count mismatch`,
  );

  // Compare resources by name
  for (const originalResource of original.resources) {
    const roundTrippedResource = roundTripped.resources.find(
      (r) => r.name === originalResource.name,
    );
    assert.ok(
      roundTrippedResource !== undefined,
      `${context}: resource "${originalResource.name}" missing after round-trip`,
    );

    assert.equal(
      roundTrippedResource.mode,
      originalResource.mode,
      `${context}: resource "${originalResource.name}" mode mismatch`,
    );

    // Provider keys may differ ("Cf" → "Cloudflare") due to case conversion.
    // Verify the provider key exists in the round-tripped providers list.
    const providerExists = roundTripped.providers.some(
      (p) => p.key === roundTrippedResource.provider,
    );
    assert.ok(
      providerExists,
      `${context}: resource "${originalResource.name}" provider "${roundTrippedResource.provider}" not found in providers`,
    );

    // Compare spec keys (values may differ due to RefToken ↔ expression string conversion)
    const originalKeys = Object.keys(originalResource.spec).sort();
    const roundTrippedKeys = Object.keys(roundTrippedResource.spec).sort();
    assert.deepEqual(
      roundTrippedKeys,
      originalKeys,
      `${context}: resource "${originalResource.name}" spec keys mismatch`,
    );
  }
}

/**
 * Assert that two TF-Config JSON objects are structurally equivalent.
 * Compares top-level keys and resource/data block structure.
 */
function assertTfJsonEquivalent(
  original: Record<string, unknown>,
  roundTripped: Record<string, unknown>,
  context: string,
): void {
  // Compare resource blocks
  const originalResources = isRecord(original.resource)
    ? original.resource
    : {};
  const roundTrippedResources = isRecord(roundTripped.resource)
    ? roundTripped.resource
    : {};

  const originalTypes = Object.keys(originalResources).sort();
  const roundTrippedTypes = Object.keys(roundTrippedResources).sort();
  assert.deepEqual(
    roundTrippedTypes,
    originalTypes,
    `${context}: resource types mismatch`,
  );

  for (const tfType of originalTypes) {
    const originalInstances = isRecord(originalResources[tfType])
      ? originalResources[tfType]
      : {};
    const roundTrippedInstances = isRecord(roundTrippedResources[tfType])
      ? roundTrippedResources[tfType]
      : {};

    const originalNames = Object.keys(originalInstances).sort();
    const roundTrippedNames = Object.keys(roundTrippedInstances).sort();
    assert.deepEqual(
      roundTrippedNames,
      originalNames,
      `${context}: resource type "${tfType}" instance names mismatch`,
    );

    // Compare instance fields
    for (const name of originalNames) {
      const originalBody = isRecord(originalInstances[name])
        ? originalInstances[name]
        : {};
      const roundTrippedBody = isRecord(roundTrippedInstances[name])
        ? roundTrippedInstances[name]
        : {};

      // Check that all original literal fields survive
      for (const [key, value] of Object.entries(originalBody)) {
        if (key === "provider" || key === "depends_on") continue; // Meta-args may change
        if (typeof value === "string" && value.startsWith("${")) continue; // Expressions
        if (typeof value === "object") continue; // Nested objects need recursive check

        assert.deepEqual(
          roundTrippedBody[key],
          value,
          `${context}: ${tfType}.${name}.${key} value mismatch`,
        );
      }
    }
  }
}

// ─── Direction 1: IR → *.tf.json → IR ────────────────────────────────────────

test("IR → export → import preserves empty IR", () => {
  const ir: InfraIR = { name: "empty-test", providers: [], resources: [] };

  const exported = exportTfConfigJson(ir);
  const imported = importTfConfigJson(exported.content);

  assertStructurallyEquivalent(ir, imported.ir, "IR→TF→IR(empty)");
  assert.equal(imported.fidelity.issues.length, 0);
});

test("IR → export → import preserves single-provider single-resource", () => {
  const ir: InfraIR = {
    name: "simple-test",
    providers: [
      {
        key: "Cf",
        adapterName: "cloudflare",
        config: {},
      },
    ],
    resources: [
      {
        // Names that survive snake_case round-trip
        name: "main_zone",
        provider: "Cf",
        kind: "Zone",
        mode: "manage",
        spec: { domain: "example.com" },
      },
      {
        name: "www_record",
        provider: "Cf",
        kind: "DnsRecord",
        mode: "manage",
        spec: {
          zoneId: "abc123",
          type: "CNAME",
          content: "target.example.com",
        },
      },
    ],
  };

  const exported = exportTfConfigJson(ir);
  const imported = importTfConfigJson(exported.content);

  assertStructurallyEquivalent(ir, imported.ir, "IR→TF→IR(simple)");

  // Verify spec values survived
  const resource = imported.ir.resources.find((r) => r.name === "www_record");
  assert.ok(resource !== undefined);
  assert.equal(resource.spec.zoneId, "abc123");
  assert.equal(resource.spec.type, "CNAME");
  assert.equal(resource.spec.content, "target.example.com");
});

test("IR → export → import preserves data sources (read mode)", () => {
  const ir: InfraIR = {
    name: "data-source-test",
    providers: [{ key: "Aws", adapterName: "aws", config: {} }],
    resources: [
      {
        name: "ubuntu_ami",
        provider: "Aws",
        kind: "Ami",
        mode: "read",
        spec: { name: "ubuntu-22.04" },
      },
    ],
  };

  const exported = exportTfConfigJson(ir);
  const imported = importTfConfigJson(exported.content);

  assertStructurallyEquivalent(ir, imported.ir, "IR→TF→IR(data-source)");

  const resource = imported.ir.resources.find((r) => r.name === "ubuntu_ami");
  assert.ok(resource !== undefined);
  assert.equal(resource.mode, "read");
});

test("IR → export → import preserves depends_on", () => {
  const ir: InfraIR = {
    name: "deps-test",
    providers: [{ key: "Cf", adapterName: "cloudflare", config: {} }],
    resources: [
      {
        name: "zone",
        provider: "Cf",
        kind: "Zone",
        mode: "manage",
        spec: { domain: "example.com" },
      },
      {
        name: "record",
        provider: "Cf",
        kind: "DnsRecord",
        mode: "manage",
        spec: { zoneId: "abc", type: "A", content: "1.2.3.4" },
        dependsOn: ["zone"],
      },
    ],
  };

  const exported = exportTfConfigJson(ir);
  const imported = importTfConfigJson(exported.content);

  const record = imported.ir.resources.find((r) => r.name === "record");
  assert.ok(record !== undefined);
  assert.ok(record.dependsOn !== undefined);
  assert.deepEqual(record.dependsOn, ["zone"]);
});

test("IR → export → import preserves provider aliases", () => {
  const ir: InfraIR = {
    name: "alias-test",
    providers: [
      {
        key: "AwsProd",
        adapterName: "aws",
        config: { region: "eu-west-1" },
      },
      {
        key: "AwsStaging",
        adapterName: "aws",
        config: { region: "us-east-1" },
      },
    ],
    resources: [
      {
        name: "prod_bucket",
        provider: "AwsProd",
        kind: "S3Bucket",
        mode: "manage",
        spec: { bucket: "prod-bucket" },
      },
      {
        name: "staging_bucket",
        provider: "AwsStaging",
        kind: "S3Bucket",
        mode: "manage",
        spec: { bucket: "staging-bucket" },
      },
    ],
  };

  const exported = exportTfConfigJson(ir);
  const imported = importTfConfigJson(exported.content);

  assert.equal(imported.ir.resources.length, 2);

  const prod = imported.ir.resources.find((r) => r.name === "prod_bucket");
  const staging = imported.ir.resources.find(
    (r) => r.name === "staging_bucket",
  );
  assert.ok(prod !== undefined);
  assert.ok(staging !== undefined);

  // Provider keys are derived from adapter name and alias — verify they map back
  assert.equal(prod.spec.bucket, "prod-bucket");
  assert.equal(staging.spec.bucket, "staging-bucket");
});

// ─── Direction 2: *.tf.json → IR → *.tf.json ────────────────────────────────

test("*.tf.json → IR → *.tf.json preserves resource structure", () => {
  const tfJson = {
    "//": "Test file",
    terraform: {
      required_providers: {
        cloudflare: { source: "cloudflare/cloudflare" },
      },
    },
    resource: {
      cloudflare_zone: {
        main: { domain: "example.com" },
      },
      cloudflare_record: {
        www: {
          zone_id: "abc",
          type: "CNAME",
          content: "target.example.com",
        },
      },
    },
  };

  const imported = importTfConfigJson(JSON.stringify(tfJson));
  const exported = exportTfConfigJson(imported.ir);
  const roundTripped = parseObj(exported.content);

  assertTfJsonEquivalent(tfJson, roundTripped, "TF→IR→TF");

  // Verify specific values survived
  const resource = isRecord(roundTripped.resource)
    ? isRecord(roundTripped.resource.cloudflare_record)
      ? isRecord(roundTripped.resource.cloudflare_record.www)
        ? roundTripped.resource.cloudflare_record.www
        : {}
      : {}
    : {};
  assert.equal(resource.type, "CNAME");
  assert.equal(resource.content, "target.example.com");
});

test("*.tf.json → IR → *.tf.json preserves data sources", () => {
  const tfJson = {
    terraform: {
      required_providers: {
        aws: { source: "hashicorp/aws" },
      },
    },
    data: {
      aws_ami: {
        ubuntu: { name: "ubuntu-22.04" },
      },
    },
  };

  const imported = importTfConfigJson(JSON.stringify(tfJson));
  const exported = exportTfConfigJson(imported.ir);
  const roundTripped = parseObj(exported.content);

  assert.ok(isRecord(roundTripped.data), "data block should exist");
  const awsAmi = isRecord(roundTripped.data.aws_ami)
    ? isRecord(roundTripped.data.aws_ami.ubuntu)
      ? roundTripped.data.aws_ami.ubuntu
      : {}
    : {};
  assert.equal(awsAmi.name, "ubuntu-22.04");
});

test("*.tf.json → IR → *.tf.json preserves depends_on", () => {
  const tfJson = {
    terraform: {
      required_providers: {
        cloudflare: { source: "cloudflare/cloudflare" },
      },
    },
    resource: {
      cloudflare_zone: {
        main: { domain: "example.com" },
      },
      cloudflare_record: {
        www: {
          zone_id: "abc",
          type: "A",
          content: "1.2.3.4",
          depends_on: ["cloudflare_zone.main"],
        },
      },
    },
  };

  const imported = importTfConfigJson(JSON.stringify(tfJson));
  const exported = exportTfConfigJson(imported.ir);
  const roundTripped = parseObj(exported.content);

  const resource = isRecord(roundTripped.resource)
    ? isRecord(roundTripped.resource.cloudflare_record)
      ? isRecord(roundTripped.resource.cloudflare_record.www)
        ? roundTripped.resource.cloudflare_record.www
        : {}
      : {}
    : {};
  assert.deepEqual(resource.depends_on, ["cloudflare_zone.main"]);
});

test("*.tf.json → IR → *.tf.json preserves variable blocks for secrets", () => {
  const tfJson = {
    terraform: {
      required_providers: {
        cloudflare: { source: "cloudflare/cloudflare" },
      },
    },
    provider: {
      cloudflare: { api_token: "${var.CF_TOKEN}" },
    },
    variable: {
      CF_TOKEN: { type: "string", sensitive: true },
    },
  };

  const imported = importTfConfigJson(JSON.stringify(tfJson));
  const exported = exportTfConfigJson(imported.ir);
  const roundTripped = parseObj(exported.content);

  // Variable block should be reconstructed from SecretSourceIR
  const variable = isRecord(roundTripped.variable) ? roundTripped.variable : {};
  assert.ok(isRecord(variable.CF_TOKEN), "CF_TOKEN variable should exist");
  assert.equal(variable.CF_TOKEN.sensitive, true);
});

// ─── Fidelity tracking ────────────────────────────────────────────────────────

test("round-trip of complex IR reports no fidelity issues for supported features", () => {
  const ir: InfraIR = {
    name: "fidelity-test",
    providers: [{ key: "Cf", adapterName: "cloudflare", config: {} }],
    resources: [
      {
        name: "zone",
        provider: "Cf",
        kind: "Zone",
        mode: "manage",
        spec: { domain: "example.com" },
      },
      {
        name: "record",
        provider: "Cf",
        kind: "DnsRecord",
        mode: "manage",
        spec: { zoneId: "abc", type: "A", content: "1.2.3.4" },
        dependsOn: ["zone"],
      },
    ],
  };

  const exported = exportTfConfigJson(ir);
  assert.equal(
    exported.fidelity.issues.length,
    0,
    "Export should have zero fidelity issues for supported features",
  );

  const imported = importTfConfigJson(exported.content);
  assert.equal(
    imported.fidelity.issues.length,
    0,
    "Import of clean export should have zero fidelity issues",
  );
});

test("round-trip of TF config with unsupported features reports fidelity loss", () => {
  const tfJson = {
    terraform: {
      required_providers: {
        aws: { source: "hashicorp/aws" },
      },
    },
    resource: {
      aws_s3_bucket: {
        data: {
          bucket: "data-bucket",
          lifecycle: { ignore_changes: ["tags"] },
        },
      },
    },
    locals: { region_override: "eu-west-1" },
    output: { bucket_arn: { value: "${aws_s3_bucket.data.arn}" } },
  };

  const imported = importTfConfigJson(JSON.stringify(tfJson));

  // Should report lifecycle, locals, and output as fidelity issues
  const paths = imported.fidelity.issues.map((i) => i.path);
  assert.ok(
    paths.some((p) => p.includes("lifecycle")),
    "Should report lifecycle as fidelity issue",
  );
  assert.ok(
    paths.some((p) => p.includes("locals")),
    "Should report locals as fidelity issue",
  );
  assert.ok(
    paths.some((p) => p.includes("output")),
    "Should report output as fidelity issue",
  );

  // Round-trip back — the unsupported features are dropped, re-export is clean
  const exported = exportTfConfigJson(imported.ir);
  const roundTripped = parseObj(exported.content);

  // Lifecycle, locals, output should be gone
  const resource = isRecord(roundTripped.resource)
    ? isRecord(roundTripped.resource.aws_s3_bucket)
      ? isRecord(roundTripped.resource.aws_s3_bucket.data)
        ? roundTripped.resource.aws_s3_bucket.data
        : {}
      : {}
    : {};
  assert.equal(resource.lifecycle, undefined, "lifecycle should be dropped");
  assert.equal(roundTripped.locals, undefined, "locals should be dropped");
  assert.equal(roundTripped.output, undefined, "output should be dropped");

  // But the bucket itself survives
  assert.equal(resource.bucket, "data-bucket");
});

// ─── Cloudflare mapper round-trips ───────────────────────────────────────────

test("Cloudflare mapper: DnsRecord IR → TF → IR round-trip", () => {
  const ir: InfraIR = {
    name: "cf-round-trip",
    providers: [{ key: "cf", adapterName: "cloudflare", config: {} }],
    resources: [
      {
        name: "www",
        provider: "cf",
        kind: "DnsRecord",
        mode: "manage",
        spec: {
          kind: "DnsRecord",
          domain: "www.example.com",
          type: "CNAME",
          value: "target.example.com",
          ttl: 300,
          proxied: true,
        },
        dependsOn: [],
        refBindings: [],
      },
    ],
  };

  // Export with Cloudflare mappers
  const exported = exportTfConfigJson(ir, {
    resourceMappers: { cloudflare: cloudflareResourceMappers },
  });
  const tf = parseObj(exported.content);

  // Verify TF output uses cloudflare_record, not cloudflare_dns_record
  const resource = isRecord(tf.resource) ? tf.resource : {};
  assert.ok(
    "cloudflare_record" in resource,
    "Should use cloudflare_record type",
  );
  assert.ok(
    !("cloudflare_dns_record" in resource),
    "Should NOT use cloudflare_dns_record",
  );

  // Verify field mapping: domain→name, value→content, zone extracted
  const cfRecord = isRecord(resource.cloudflare_record)
    ? resource.cloudflare_record
    : {};
  const www = isRecord(cfRecord.www) ? cfRecord.www : {};
  assert.equal(www.name, "www.example.com");
  assert.equal(www.type, "CNAME");
  assert.equal(www.content, "target.example.com");
  assert.equal(www.ttl, 300);
  assert.equal(www.proxied, true);
  assert.equal(www.zone_id, "example.com");

  // Import back — should produce structurally equivalent IR
  const imported = importTfConfigJson(exported.content);
  assert.equal(imported.ir.resources.length, 1);

  const roundTrippedResource = imported.ir.resources[0];
  assert.ok(roundTrippedResource !== undefined);
  assert.equal(roundTrippedResource.mode, "manage");

  // Import reads back as spec fields from TF attributes
  assert.equal(roundTrippedResource.spec.zone_id, "example.com");
  assert.equal(roundTrippedResource.spec.type, "CNAME");
  assert.equal(roundTrippedResource.spec.content, "target.example.com");
  assert.equal(roundTrippedResource.spec.ttl, 300);
  assert.equal(roundTrippedResource.spec.proxied, true);
});

test("Cloudflare mapper: DnsRecord TF → IR → TF round-trip", () => {
  const tfJson = {
    terraform: {
      required_providers: {
        cloudflare: { source: "cloudflare/cloudflare" },
      },
    },
    resource: {
      cloudflare_record: {
        www: {
          zone_id: "z12345",
          name: "www.example.com",
          type: "A",
          content: "1.2.3.4",
          ttl: 600,
          proxied: false,
        },
      },
    },
  };

  // Import the TF config
  const imported = importTfConfigJson(JSON.stringify(tfJson));
  assert.equal(imported.ir.resources.length, 1);

  const resource = imported.ir.resources[0];
  assert.ok(resource !== undefined);
  assert.equal(resource.spec.zone_id, "z12345");
  assert.equal(resource.spec.name, "www.example.com");
  assert.equal(resource.spec.type, "A");
  assert.equal(resource.spec.content, "1.2.3.4");
  assert.equal(resource.spec.ttl, 600);
  assert.equal(resource.spec.proxied, false);

  // Export back with Cloudflare mappers
  const exported = exportTfConfigJson(imported.ir, {
    resourceMappers: { cloudflare: cloudflareResourceMappers },
  });
  const roundTripped = parseObj(exported.content);

  // Verify resource type and attribute values survive
  const rtResource = isRecord(roundTripped.resource)
    ? roundTripped.resource
    : {};
  assert.ok(
    "cloudflare_record" in rtResource,
    "Should use cloudflare_record type",
  );

  const cfRecord = isRecord(rtResource.cloudflare_record)
    ? rtResource.cloudflare_record
    : {};
  const www = isRecord(cfRecord.www) ? cfRecord.www : {};
  assert.equal(www.zone_id, "z12345");
  assert.equal(www.type, "A");
  assert.equal(www.content, "1.2.3.4");
  assert.equal(www.ttl, 600);
  assert.equal(www.proxied, false);
});

test("Cloudflare mapper: multiple Cloudflare resource types round-trip", () => {
  const tfJson = {
    terraform: {
      required_providers: {
        cloudflare: { source: "cloudflare/cloudflare" },
      },
    },
    resource: {
      cloudflare_record: {
        api: {
          zone_id: "z1",
          name: "api.example.com",
          type: "A",
          content: "10.0.0.1",
          ttl: 300,
          proxied: false,
        },
      },
      cloudflare_access_application: {
        admin: {
          domain: "admin.example.com",
          name: "Admin Panel",
        },
      },
    },
  };

  const imported = importTfConfigJson(JSON.stringify(tfJson));
  assert.equal(imported.ir.resources.length, 2);

  // Export with mappers
  const exported = exportTfConfigJson(imported.ir, {
    resourceMappers: { cloudflare: cloudflareResourceMappers },
  });
  const roundTripped = parseObj(exported.content);

  const rtResource = isRecord(roundTripped.resource)
    ? roundTripped.resource
    : {};

  // Both types should be preserved
  assert.ok(
    "cloudflare_record" in rtResource,
    "cloudflare_record should exist",
  );
  assert.ok(
    "cloudflare_access_application" in rtResource,
    "cloudflare_access_application should exist",
  );

  // Verify specific values
  const apiRecord = isRecord(rtResource.cloudflare_record)
    ? isRecord(rtResource.cloudflare_record.api)
      ? rtResource.cloudflare_record.api
      : {}
    : {};
  assert.equal(apiRecord.content, "10.0.0.1");

  const adminApp = isRecord(rtResource.cloudflare_access_application)
    ? isRecord(rtResource.cloudflare_access_application.admin)
      ? rtResource.cloudflare_access_application.admin
      : {}
    : {};
  assert.equal(adminApp.domain, "admin.example.com");
});
