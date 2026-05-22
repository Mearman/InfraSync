/**
 * Unit tests for roles — reusable, parameterised infrastructure configs.
 *
 * Tests that defineRole() and useRole() correctly create namespaced
 * child scopes, validate params, prefix resource names, produce ref
 * bindings, and compose via nesting.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { defineInfra } from "../compiler.js";
import { defineProvider } from "../provider.js";
import type { ProviderPort, ResourcePort, ResolvedScopes } from "../provider.js";
import { defineRole, useRole } from "../role.js";
import type { RoleHandle } from "../role.js";
import { RefToken } from "../refs.js";

// ─── Mock adapter ────────────────────────────────────────────────────────────

const mockConfigSchema = z.strictObject({});

class MockProvider implements ProviderPort {
  readonly name = "mock";
  readonly configSchema = mockConfigSchema;

  async connect(): Promise<void> {
    /* no-op */
  }
  async disconnect(): Promise<void> {
    /* no-op */
  }

  supportedKinds(): string[] {
    return ["Resource", "DnsRecord", "Zone", "Service"];
  }

  resourceHandler(_kind: string, _scopes: ResolvedScopes): ResourcePort {
    throw new Error("Not used in role tests");
  }
}

const mock = defineProvider("mock", () => new MockProvider());

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Non-null assertion for array index access under noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Index ${String(index)} out of bounds`);
  }
  return value;
}

// ─── Role definition ─────────────────────────────────────────────────────────

describe("defineRole", () => {
  it("creates a role definition with a name and params schema", () => {
    const role = defineRole("webApp", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        prov.resource("DnsRecord", "record", { domain: params.domain });
        return { outputs: {} };
      },
    });

    assert.equal(role.name, "webApp");
    // Params schema is preserved
    const parsed = role.paramsSchema.safeParse({ domain: "example.com" });
    assert.ok(parsed.success, "params schema should validate correct input");
  });

  it("freezes the role definition object", () => {
    const role = defineRole("test", {
      params: z.object({}),
      create() {
        return { outputs: {} };
      },
    });

    assert.ok(Object.isFrozen(role), "role definition should be frozen");
  });
});

// ─── Resource namespacing ────────────────────────────────────────────────────

describe("Resource namespacing", () => {
  it("prefixes resource names with the role name by default", () => {
    const role = defineRole("webApp", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        prov.resource("DnsRecord", "record", { domain: params.domain });
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, role, { domain: "example.com" });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.resources.length, 1);
    assert.equal(at(ir.resources, 0).name, "webApp:record");
  });

  it("uses a custom prefix when provided", () => {
    const role = defineRole("app", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        prov.resource("DnsRecord", "record", { domain: params.domain });
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, role, { domain: "example.com" }, { prefix: "frontend" });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.resources.length, 1);
    assert.equal(at(ir.resources, 0).name, "frontend:record");
  });

  it("creates distinct resources when the same role is used twice", () => {
    const role = defineRole("app", {
      params: z.object({ name: z.string() }),
      create(infra, params) {
        const prov = infra.provider("svc", mock, {});
        prov.resource("Resource", "main", { name: params.name });
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, role, { name: "alpha" }, { prefix: "alpha" });
      useRole(i, role, { name: "beta" }, { prefix: "beta" });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.resources.length, 2);

    const names = ir.resources.map((r) => r.name);
    assert.ok(names.includes("alpha:main"), "alpha:main should exist");
    assert.ok(names.includes("beta:main"), "beta:main should exist");
  });

  it("registers role providers in the compiled IR", () => {
    const role = defineRole("app", {
      params: z.object({ region: z.string() }),
      create(infra, params) {
        infra.provider("aws", mock, { region: params.region });
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, role, { region: "eu-west-1" });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.providers.length, 1);
    assert.equal(at(ir.providers, 0).key, "aws");
    assert.equal(at(ir.providers, 0).config.region, "eu-west-1");
  });
});

// ─── Params validation ───────────────────────────────────────────────────────

describe("Params validation", () => {
  it("throws on invalid params at useRole() time", () => {
    const role = defineRole("app", {
      params: z.object({
        domain: z.string().min(1),
        port: z.number().int().positive(),
      }),
      create(infra, params) {
        const prov = infra.provider("svc", mock, {});
        prov.resource("Resource", "main", {
          domain: params.domain,
          port: params.port,
        });
        return { outputs: {} };
      },
    });

    assert.throws(
      () => {
        defineInfra("test", (i) => {
          useRole(i, role, { domain: "", port: -1 });
          return { outputs: {} };
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /Role "app" params validation failed/,
          "error should mention the role name",
        );
        return true;
      },
    );
  });

  it("throws on missing required params", () => {
    const role = defineRole("app", {
      params: z.strictObject({ domain: z.string() }),
      create(infra, params) {
        infra.provider("svc", mock, {});
        infra.provider("svc", mock, { domain: params.domain });
        return { outputs: {} };
      },
    });

    assert.throws(
      () => {
        defineInfra("test", (i) => {
          // @ts-expect-error — intentionally passing wrong params to test runtime validation
          useRole(i, role, {});
          return { outputs: {} };
        });
      },
      /Role "app" params validation failed/,
    );
  });
});

// ─── Ref resolution from role outputs ────────────────────────────────────────

describe("Ref resolution from role outputs", () => {
  it("returns RefTokens pointing at namespaced resource names", () => {
    const role = defineRole("app", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        const record = prov.resource("DnsRecord", "record", {
          domain: params.domain,
        });
        return {
          outputs: {
            hostname: record.ref.ref("hostname"),
            endpoint: record.ref.ref("endpoint"),
          },
        };
      },
    });

    let handle: RoleHandle<{ hostname: RefToken; endpoint: RefToken }> | undefined;

    defineInfra("test", (i) => {
      handle = useRole(i, role, { domain: "example.com" });
      return { outputs: {} };
    });

    assert.ok(handle !== undefined, "handle should be set");
    assert.ok(handle.outputs.hostname instanceof RefToken);
    assert.equal(handle.outputs.hostname.resource, "app:record");
    assert.equal(handle.outputs.hostname.path, "hostname");
    assert.ok(handle.outputs.endpoint instanceof RefToken);
    assert.equal(handle.outputs.endpoint.resource, "app:record");
    assert.equal(handle.outputs.endpoint.path, "endpoint");
  });

  it("role outputs can be used as RefTokens in parent resources", () => {
    const role = defineRole("dns", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        const record = prov.resource("DnsRecord", "record", {
          domain: params.domain,
        });
        return { outputs: { hostname: record.ref.ref("hostname") } };
      },
    });

    const infra = defineInfra("test", (i) => {
      const dns = useRole(i, role, { domain: "example.com" });

      const svc = i.provider("svc", mock, {});
      svc.resource("Service", "api", {
        name: "my-api",
        endpoint: dns.outputs.hostname,
      });

      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.resources.length, 2);

    // The Service resource should have a ref binding to dns:record
    const api = ir.resources.find((r) => r.name === "api");
    assert.ok(api !== undefined, "api resource should exist");
    assert.ok(api.refBindings !== undefined, "api should have refBindings");
    assert.equal(api.refBindings!.length, 1);
    assert.equal(at(api.refBindings!, 0).targetResource, "dns:record");
    assert.equal(at(api.refBindings!, 0).specPath, "endpoint");
    assert.equal(at(api.refBindings!, 0).statePath, "hostname");

    // The compiled spec should contain the serialised RefTokenIR
    const specValue = api.spec.endpoint;
    assert.ok(
      typeof specValue === "object" &&
        specValue !== null &&
        "$ref" in specValue,
      `spec.endpoint should be a RefTokenIR, got: ${JSON.stringify(specValue)}`,
    );
  });

  it("outputs from different role uses are distinct", () => {
    const role = defineRole("app", {
      params: z.object({ name: z.string() }),
      create(infra, params) {
        const prov = infra.provider("svc", mock, {});
        const res = prov.resource("Resource", "main", { name: params.name });
        return { outputs: { id: res.ref.ref("id") } };
      },
    });

    let handle1: RoleHandle<{ id: RefToken }> | undefined;
    let handle2: RoleHandle<{ id: RefToken }> | undefined;

    defineInfra("test", (i) => {
      handle1 = useRole(i, role, { name: "alpha" }, { prefix: "alpha" });
      handle2 = useRole(i, role, { name: "beta" }, { prefix: "beta" });
      return { outputs: {} };
    });

    assert.ok(handle1 !== undefined);
    assert.ok(handle2 !== undefined);

    // Each handle's outputs point at different namespaced resources
    assert.equal(handle1.outputs.id.resource, "alpha:main");
    assert.equal(handle2.outputs.id.resource, "beta:main");
  });
});

// ─── DAG participation ───────────────────────────────────────────────────────

describe("DAG participation", () => {
  it("role resources form ref bindings for cross-resource refs", () => {
    const role = defineRole("app", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        const zone = prov.resource("Zone", "zone", { domain: params.domain });
        prov.resource("DnsRecord", "record", {
          domain: params.domain,
          zoneId: zone.ref.ref("zoneId"),
        });
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, role, { domain: "example.com" });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.resources.length, 2);

    const record = ir.resources.find((r) => r.name === "app:record");
    assert.ok(record !== undefined, "app:record should exist");

    // record should have a ref binding to app:zone
    assert.ok(record.refBindings !== undefined);
    assert.equal(record.refBindings!.length, 1);
    assert.equal(at(record.refBindings!, 0).targetResource, "app:zone");
    assert.equal(at(record.refBindings!, 0).specPath, "zoneId");
    assert.equal(at(record.refBindings!, 0).statePath, "zoneId");
  });

  it("role resources support explicit dependsOn", () => {
    const role = defineRole("app", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        const zone = prov.resource("Zone", "zone", { domain: params.domain });
        prov.resource(
          "DnsRecord",
          "record",
          { domain: params.domain },
          { dependsOn: [zone] },
        );
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, role, { domain: "example.com" });
      return { outputs: {} };
    });

    const ir = infra.toIR();

    const record = ir.resources.find((r) => r.name === "app:record");
    assert.ok(record !== undefined, "app:record should exist");
    assert.ok(record.dependsOn !== undefined, "record should have dependsOn");
    assert.deepEqual([...record.dependsOn!], ["app:zone"]);
  });

  it("role resources with tags are preserved in the IR", () => {
    const role = defineRole("app", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        prov.resource(
          "DnsRecord",
          "record",
          { domain: params.domain },
          { tags: ["public", "dns"] },
        );
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, role, { domain: "example.com" });
      return { outputs: {} };
    });

    const ir = infra.toIR();

    const record = ir.resources.find((r) => r.name === "app:record");
    assert.ok(record !== undefined);
    assert.ok(record.tags !== undefined);
    assert.deepEqual([...record.tags!], ["public", "dns"]);
  });

  it("role resources support read mode", () => {
    const role = defineRole("app", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        prov.resource(
          "DnsRecord",
          "record",
          { domain: params.domain },
          { mode: "read" },
        );
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, role, { domain: "example.com" });
      return { outputs: {} };
    });

    const ir = infra.toIR();

    const record = ir.resources.find((r) => r.name === "app:record");
    assert.ok(record !== undefined);
    assert.equal(record.mode, "read");
  });
});

// ─── Nested roles ────────────────────────────────────────────────────────────

describe("Nested roles", () => {
  it("inner role resources get their own prefix", () => {
    const inner = defineRole("dns", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        const record = prov.resource("DnsRecord", "record", {
          domain: params.domain,
        });
        return { outputs: { hostname: record.ref.ref("hostname") } };
      },
    });

    const outer = defineRole("app", {
      params: z.object({ appName: z.string(), domain: z.string() }),
      create(infra, params) {
        const dns = useRole(infra, inner, { domain: params.domain });
        const prov = infra.provider("svc", mock, {});
        prov.resource("Service", "api", {
          name: params.appName,
          endpoint: dns.outputs.hostname,
        });
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, outer, { appName: "myapp", domain: "example.com" });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    assert.equal(ir.resources.length, 2);

    const names = ir.resources.map((r) => r.name);
    assert.ok(names.includes("dns:record"), "dns:record should exist");
    assert.ok(names.includes("app:api"), "app:api should exist");
  });

  it("inner role outputs cross-reference correctly", () => {
    const inner = defineRole("dns", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        const record = prov.resource("DnsRecord", "record", {
          domain: params.domain,
        });
        return { outputs: { hostname: record.ref.ref("hostname") } };
      },
    });

    const outer = defineRole("app", {
      params: z.object({ appName: z.string(), domain: z.string() }),
      create(infra, params) {
        const dns = useRole(infra, inner, { domain: params.domain });
        const prov = infra.provider("svc", mock, {});
        prov.resource("Service", "api", {
          name: params.appName,
          endpoint: dns.outputs.hostname,
        });
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, outer, { appName: "myapp", domain: "example.com" });
      return { outputs: {} };
    });

    const ir = infra.toIR();

    // The Service should have a ref binding to dns:record
    const api = ir.resources.find((r) => r.name === "app:api");
    assert.ok(api !== undefined);
    assert.ok(api.refBindings !== undefined);
    assert.equal(api.refBindings!.length, 1);
    assert.equal(at(api.refBindings!, 0).targetResource, "dns:record");
    assert.equal(at(api.refBindings!, 0).statePath, "hostname");
  });

  it("inner role can have a custom prefix", () => {
    const inner = defineRole("dns", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const prov = infra.provider("cf", mock, {});
        const record = prov.resource("DnsRecord", "record", {
          domain: params.domain,
        });
        return { outputs: { hostname: record.ref.ref("hostname") } };
      },
    });

    const outer = defineRole("app", {
      params: z.object({ domain: z.string() }),
      create(infra, params) {
        const dns = useRole(infra, inner, { domain: params.domain }, { prefix: "frontendDns" });
        const prov = infra.provider("svc", mock, {});
        prov.resource("Service", "api", {
          name: "my-api",
          endpoint: dns.outputs.hostname,
        });
        return { outputs: {} };
      },
    });

    const infra = defineInfra("test", (i) => {
      useRole(i, outer, { domain: "example.com" });
      return { outputs: {} };
    });

    const ir = infra.toIR();
    const names = ir.resources.map((r) => r.name);
    assert.ok(
      names.includes("frontendDns:record"),
      "inner role should use custom prefix",
    );
    assert.ok(names.includes("app:api"), "outer role uses default prefix");
  });
});
