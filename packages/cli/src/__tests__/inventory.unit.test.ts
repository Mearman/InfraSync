/**
 * Unit tests for inventory loading, env var interpolation, and config merging.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  loadInventory,
  mergeInventoryConfig,
  inventorySchema,
} from "../inventory.js";
import type { InfraIR } from "@infrasync-org/core/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TMP_DIR = join(
  import.meta.dirname,
  "__tests__",
  "fixtures",
  "inventory-tmp",
);

async function writeTmpFile(
  filename: string,
  content: string,
): Promise<string> {
  await mkdir(TMP_DIR, { recursive: true });
  const filePath = join(TMP_DIR, filename);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

/** Build a minimal InfraIR for testing. */
function makeIR(providers: InfraIR["providers"]): InfraIR {
  return {
    name: "test",
    providers,
    resources: [],
  };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── Schema validation ──────────────────────────────────────────────────────

describe("inventorySchema", () => {
  it("accepts a valid inventory", () => {
    const result = inventorySchema.safeParse({
      providers: {
        awsProd: { region: "us-east-1", accountId: "123456" },
      },
    });
    assert.equal(result.success, true);
  });

  it("accepts an empty providers object", () => {
    const result = inventorySchema.safeParse({ providers: {} });
    assert.equal(result.success, true);
  });

  it("accepts empty config for a provider", () => {
    const result = inventorySchema.safeParse({
      providers: { myProvider: {} },
    });
    assert.equal(result.success, true);
  });

  it("rejects missing providers field", () => {
    const result = inventorySchema.safeParse({});
    assert.equal(result.success, false);
  });

  it("rejects providers with non-object values", () => {
    const result = inventorySchema.safeParse({
      providers: { myProvider: "not-an-object" },
    });
    assert.equal(result.success, false);
  });
});

// ─── Loading JSON ────────────────────────────────────────────────────────────

describe("loadInventory (JSON)", () => {
  it("loads a valid JSON inventory", async () => {
    const path = await writeTmpFile(
      "valid.json",
      JSON.stringify({
        providers: {
          awsProd: { region: "us-east-1" },
          cfStaging: { apiKey: "abc123" },
        },
      }),
    );

    const inventory = await loadInventory(path);

    assert.deepEqual(Object.keys(inventory.providers), [
      "awsProd",
      "cfStaging",
    ]);
    assert.equal(inventory.providers.awsProd?.region, "us-east-1");
    assert.equal(inventory.providers.cfStaging?.apiKey, "abc123");
  });

  it("loads an empty inventory file", async () => {
    const path = await writeTmpFile(
      "empty.json",
      JSON.stringify({ providers: {} }),
    );

    const inventory = await loadInventory(path);
    assert.deepEqual(inventory.providers, {});
  });

  it("throws on invalid JSON", async () => {
    const path = await writeTmpFile("bad.json", "not json");

    await assert.rejects(() => loadInventory(path), {
      message: /Failed to parse JSON/,
    });
  });

  it("throws on invalid inventory structure", async () => {
    const path = await writeTmpFile(
      "invalid.json",
      JSON.stringify({ notProviders: {} }),
    );

    await assert.rejects(() => loadInventory(path), {
      message: /Invalid inventory/,
    });
  });
});

// ─── Loading YAML ────────────────────────────────────────────────────────────

describe("loadInventory (YAML)", () => {
  it("loads a valid YAML inventory", async () => {
    const path = await writeTmpFile(
      "valid.yaml",
      `providers:
  awsProd:
    region: us-east-1
    accountId: "123456"
  cfStaging:
    apiKey: abc123
`,
    );

    const inventory = await loadInventory(path);

    assert.deepEqual(Object.keys(inventory.providers), [
      "awsProd",
      "cfStaging",
    ]);
    assert.equal(inventory.providers.awsProd?.region, "us-east-1");
    assert.equal(inventory.providers.awsProd?.accountId, "123456");
  });

  it("loads a .yml file", async () => {
    const path = await writeTmpFile(
      "valid.yml",
      `providers:
  myProvider:
    key: value
`,
    );

    const inventory = await loadInventory(path);
    assert.equal(inventory.providers.myProvider?.key, "value");
  });

  it("loads an empty YAML inventory", async () => {
    const path = await writeTmpFile(
      "empty.yaml",
      `providers: {}
`,
    );

    const inventory = await loadInventory(path);
    assert.deepEqual(inventory.providers, {});
  });
});

// ─── Environment variable interpolation ──────────────────────────────────────

describe("loadInventory — env var interpolation", () => {
  const originalEnvValues = new Map<string, string | undefined>();

  function setEnv(key: string, value: string): void {
    originalEnvValues.set(key, process.env[key]);
    process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, original] of originalEnvValues) {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = original;
      }
    }
    originalEnvValues.clear();
  });

  it("interpolates ${VAR} in string values", async () => {
    setEnv("AWS_REGION", "eu-west-1");
    setEnv("AWS_ACCOUNT", "987654");

    const path = await writeTmpFile(
      "env.json",
      JSON.stringify({
        providers: {
          awsProd: {
            region: "${AWS_REGION}",
            accountId: "${AWS_ACCOUNT}",
          },
        },
      }),
    );

    const inventory = await loadInventory(path);
    assert.equal(inventory.providers.awsProd?.region, "eu-west-1");
    assert.equal(inventory.providers.awsProd?.accountId, "987654");
  });

  it("interpolates env vars in YAML values", async () => {
    setEnv("CF_API_KEY", "secret-key-123");

    const path = await writeTmpFile(
      "env.yaml",
      `providers:
  cf:
    apiKey: \${CF_API_KEY}
`,
    );

    const inventory = await loadInventory(path);
    assert.equal(inventory.providers.cf?.apiKey, "secret-key-123");
  });

  it("throws a descriptive error for missing env vars", async () => {
    delete process.env.DEFINITELY_MISSING_VAR;

    const path = await writeTmpFile(
      "missing-env.json",
      JSON.stringify({
        providers: {
          aws: { region: "${DEFINITELY_MISSING_VAR}" },
        },
      }),
    );

    await assert.rejects(() => loadInventory(path), {
      message: /Missing required environment variable "DEFINITELY_MISSING_VAR"/,
    });
  });

  it("interpolates multiple env vars in a single string", async () => {
    setEnv("HOST", "db.example.com");
    setEnv("PORT", "5432");

    const path = await writeTmpFile(
      "multi-env.json",
      JSON.stringify({
        providers: {
          db: { url: "postgres://${HOST}:${PORT}/mydb" },
        },
      }),
    );

    const inventory = await loadInventory(path);
    assert.equal(
      inventory.providers.db?.url,
      "postgres://db.example.com:5432/mydb",
    );
  });

  it("leaves non-string values untouched", async () => {
    const path = await writeTmpFile(
      "non-string.json",
      JSON.stringify({
        providers: {
          aws: {
            region: "us-east-1",
            maxRetries: 3,
            enabled: true,
            timeout: null,
          },
        },
      }),
    );

    const inventory = await loadInventory(path);
    assert.equal(inventory.providers.aws?.maxRetries, 3);
    assert.equal(inventory.providers.aws?.enabled, true);
    assert.equal(inventory.providers.aws?.timeout, null);
  });

  it("interpolates env vars in nested objects", async () => {
    setEnv("NESTED_SECRET", "nested-value");

    const path = await writeTmpFile(
      "nested-env.json",
      JSON.stringify({
        providers: {
          aws: {
            auth: { token: "${NESTED_SECRET}", mode: "bearer" },
          },
        },
      }),
    );

    const inventory = await loadInventory(path);
    const auth = inventory.providers.aws?.auth as Record<string, unknown>;
    assert.equal(auth.token, "nested-value");
    assert.equal(auth.mode, "bearer");
  });

  it("interpolates env vars in arrays", async () => {
    setEnv("TAG_VALUE", "production");

    const path = await writeTmpFile(
      "array-env.json",
      JSON.stringify({
        providers: {
          aws: { tags: ["${TAG_VALUE}", "static"] },
        },
      }),
    );

    const inventory = await loadInventory(path);
    assert.deepEqual(inventory.providers.aws?.tags, ["production", "static"]);
  });
});

// ─── Config merging ──────────────────────────────────────────────────────────

describe("mergeInventoryConfig", () => {
  it("overrides infra config with inventory values", () => {
    const ir = makeIR([
      {
        key: "awsProd",
        adapterName: "aws",
        config: { region: "us-east-1", accountId: "111" },
      },
    ]);

    const merged = mergeInventoryConfig(ir, {
      providers: {
        awsProd: { region: "eu-west-1", accountId: "222" },
      },
    });

    assert.equal(merged.providers[0]?.key, "awsProd");
    assert.equal(merged.providers[0]?.config.region, "eu-west-1");
    assert.equal(merged.providers[0]?.config.accountId, "222");
  });

  it("deep-merges nested config values", () => {
    const ir = makeIR([
      {
        key: "aws",
        adapterName: "aws",
        config: {
          auth: { method: "key", keyId: "abc", secret: "old" },
          region: "us-east-1",
        },
      },
    ]);

    const merged = mergeInventoryConfig(ir, {
      providers: {
        aws: { auth: { secret: "new" } },
      },
    });

    // Deep merge: auth.method and auth.keyId preserved, auth.secret overridden
    const auth = merged.providers[0]?.config.auth as Record<string, unknown>;
    assert.equal(auth.method, "key");
    assert.equal(auth.keyId, "abc");
    assert.equal(auth.secret, "new");
    // Top-level region preserved
    assert.equal(merged.providers[0]?.config.region, "us-east-1");
  });

  it("provides partial override (inventory has some fields, infra has others)", () => {
    const ir = makeIR([
      {
        key: "cf",
        adapterName: "cloudflare",
        config: { accountId: "acc123", zoneId: "zone456" },
      },
    ]);

    const merged = mergeInventoryConfig(ir, {
      providers: {
        cf: { accountId: "acc999" },
      },
    });

    assert.equal(merged.providers[0]?.config.accountId, "acc999");
    assert.equal(merged.providers[0]?.config.zoneId, "zone456");
  });

  it("handles multiple providers in one inventory", () => {
    const ir = makeIR([
      {
        key: "aws",
        adapterName: "aws",
        config: { region: "us-east-1" },
      },
      {
        key: "cf",
        adapterName: "cloudflare",
        config: { accountId: "acc123" },
      },
    ]);

    const merged = mergeInventoryConfig(ir, {
      providers: {
        aws: { region: "eu-west-1" },
        cf: { accountId: "acc999" },
      },
    });

    assert.equal(merged.providers[0]?.config.region, "eu-west-1");
    assert.equal(merged.providers[1]?.config.accountId, "acc999");
  });

  it("ignores unknown provider keys in inventory", () => {
    const ir = makeIR([
      {
        key: "aws",
        adapterName: "aws",
        config: { region: "us-east-1" },
      },
    ]);

    const merged = mergeInventoryConfig(ir, {
      providers: {
        unknownProvider: { someKey: "someValue" },
      },
    });

    // IR unchanged — unknown key was ignored
    assert.equal(merged.providers.length, 1);
    assert.equal(merged.providers[0]?.config.region, "us-east-1");
  });

  it("leaves providers unchanged when inventory is empty", () => {
    const ir = makeIR([
      {
        key: "aws",
        adapterName: "aws",
        config: { region: "us-east-1" },
      },
    ]);

    const merged = mergeInventoryConfig(ir, { providers: {} });

    assert.equal(merged.providers.length, 1);
    assert.equal(merged.providers[0]?.config.region, "us-east-1");
  });

  it("leaves providers unchanged when no matching inventory key exists", () => {
    const ir = makeIR([
      {
        key: "aws",
        adapterName: "aws",
        config: { region: "us-east-1" },
      },
    ]);

    const merged = mergeInventoryConfig(ir, {
      providers: {
        gcp: { project: "my-project" },
      },
    });

    assert.equal(merged.providers[0]?.config.region, "us-east-1");
  });

  it("preserves IR name and resources unchanged", () => {
    const ir: InfraIR = {
      name: "my-infra",
      providers: [
        {
          key: "aws",
          adapterName: "aws",
          config: { region: "us-east-1" },
        },
      ],
      resources: [
        {
          name: "my-bucket",
          provider: "aws",
          kind: "S3Bucket",
          mode: "manage",
          spec: { bucket: "my-bucket" },
        },
      ],
    };

    const merged = mergeInventoryConfig(ir, {
      providers: { aws: { region: "eu-west-1" } },
    });

    assert.equal(merged.name, "my-infra");
    assert.equal(merged.resources.length, 1);
    assert.equal(merged.resources[0]?.name, "my-bucket");
  });

  it("adds new config keys from inventory that don't exist in infra", () => {
    const ir = makeIR([
      {
        key: "aws",
        adapterName: "aws",
        config: { region: "us-east-1" },
      },
    ]);

    const merged = mergeInventoryConfig(ir, {
      providers: {
        aws: { newKey: "newValue" },
      },
    });

    assert.equal(merged.providers[0]?.config.region, "us-east-1");
    assert.equal(merged.providers[0]?.config.newKey, "newValue");
  });
});
