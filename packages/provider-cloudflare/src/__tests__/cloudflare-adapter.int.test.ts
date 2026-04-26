/**
 * Integration tests for Cloudflare adapter resources.
 *
 * Uses mock Cloudflare SDK clients to verify that each resource adapter
 * calls the correct SDK endpoints with the correct parameters,
 * including scope resolution via constructor injection.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type Cloudflare from "cloudflare";
import {
  ResolvedScopes,
  type ResourceScopes,
  type ScopeSource,
} from "@infrasync/core/provider";
import { isRecord } from "@infrasync/core/resource";
import { AccessPolicyResource } from "../access-policy.js";
import { AccessApplicationResource } from "../access-app.js";
import { IdentityProviderResource } from "../identity-provider.js";
import { PagesCustomDomainResource } from "../pages-domain.js";
import { DnsRecordResource } from "../dns-record.js";
import { AccessGroupResource } from "../access-group.js";
import { TunnelResource } from "../tunnel.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

const ACCOUNT_ID = "test-account-id";
const APPLICATION_ID = "app-123";
const POLICY_ID = "policy-456";

const ACCOUNT_SCOPES = new ResolvedScopes([["accountId", ACCOUNT_ID]]);

const POLICY_SCOPES = new ResolvedScopes([
  ["accountId", ACCOUNT_ID],
  ["applicationId", APPLICATION_ID],
]);

/** Non-null assertion for array index access under noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Index ${String(index)} out of bounds`);
  }
  return value;
}

/** Extract string argument from a mock call by position. */
function stringArg(
  calls: { readonly arguments: readonly unknown[] }[],
  callIndex: number,
  argIndex: number,
): string {
  const call = at(calls, callIndex);
  const value = at(call.arguments, argIndex);
  if (typeof value !== "string") {
    throw new Error(
      `Expected string at call[${String(callIndex)}].args[${String(argIndex)}], got ${typeof value}`,
    );
  }
  return value;
}

/** Extract object argument from a mock call by position. */
function objectArg(
  calls: { readonly arguments: readonly unknown[] }[],
  callIndex: number,
  argIndex: number,
): Record<string, unknown> {
  const call = at(calls, callIndex);
  const value = at(call.arguments, argIndex);
  if (!isRecord(value)) {
    throw new Error(
      `Expected object at call[${String(callIndex)}].args[${String(argIndex)}], got ${typeof value}`,
    );
  }
  return value;
}

/** Cast helper for mock Cloudflare client. */
function asClient(mockObj: object): Cloudflare {
  return mockObj as unknown as Cloudflare;
}

/** Narrow a Record index access after key-existence is verified by assertion. */
function scopeAt(scopes: ResourceScopes, key: string): ScopeSource {
  const value = (scopes as Record<string, ScopeSource>)[key];
  if (value === undefined) {
    throw new Error(`Scope key '${key}' not found`);
  }
  return value;
}

// ─── AccessPolicyResource ────────────────────────────────────────────────────

describe("AccessPolicyResource", () => {
  it("passes applicationId to create SDK call (app-scoped API)", async () => {
    const createSpy = mock.fn(() => ({
      id: POLICY_ID,
      name: "Allow Team",
      decision: "allow",
      include: [],
    }));
    const mockClient = {
      zeroTrust: {
        access: {
          applications: {
            policies: {
              list: mock.fn(() => ({ result: [] })),
              create: createSpy,
              update: mock.fn(),
            },
          },
        },
      },
    };

    const resource = new AccessPolicyResource(
      asClient(mockClient),
      POLICY_SCOPES,
    );

    await resource.create({
      kind: "AccessPolicy",
      applicationId: APPLICATION_ID,
      name: "Allow Team",
      decision: "allow",
      include: [{ email_domain: { domain: "example.com" } }],
    });

    assert.equal(createSpy.mock.callCount(), 1, "expected one create call");
    assert.equal(stringArg(createSpy.mock.calls, 0, 0), APPLICATION_ID);
  });

  it("passes applicationId and policyId to update SDK call (app-scoped API)", async () => {
    const updateSpy = mock.fn(() => ({
      id: POLICY_ID,
      name: "Allow Team",
      decision: "allow",
      include: [],
    }));
    const mockClient = {
      zeroTrust: {
        access: {
          applications: {
            policies: {
              list: mock.fn(() => ({ result: [] })),
              create: mock.fn(),
              update: updateSpy,
            },
          },
        },
      },
    };

    const resource = new AccessPolicyResource(
      asClient(mockClient),
      POLICY_SCOPES,
    );

    await resource.update(POLICY_ID, {
      kind: "AccessPolicy",
      applicationId: APPLICATION_ID,
      name: "Allow Team",
      decision: "allow",
      include: [{ email_domain: { domain: "example.com" } }],
    });

    assert.equal(updateSpy.mock.callCount(), 1, "expected one update call");
    assert.equal(
      stringArg(updateSpy.mock.calls, 0, 0),
      APPLICATION_ID,
      "first arg must be appId",
    );
    assert.equal(
      stringArg(updateSpy.mock.calls, 0, 1),
      POLICY_ID,
      "second arg must be policyId",
    );
  });

  it("queries policies scoped to the application in read", async () => {
    const listSpy = mock.fn(() => ({
      result: [
        {
          id: POLICY_ID,
          name: "Allow Team",
          decision: "allow",
          include: [],
        },
      ],
    }));
    const mockClient = {
      zeroTrust: {
        access: {
          applications: {
            policies: {
              list: listSpy,
              create: mock.fn(),
              update: mock.fn(),
            },
          },
        },
      },
    };

    const resource = new AccessPolicyResource(
      asClient(mockClient),
      POLICY_SCOPES,
    );

    await resource.read({
      kind: "AccessPolicy",
      applicationId: APPLICATION_ID,
      name: "Allow Team",
      decision: "allow",
      include: [],
    });

    assert.equal(listSpy.mock.callCount(), 1);
    assert.equal(stringArg(listSpy.mock.calls, 0, 0), APPLICATION_ID);
  });

  it("declares accountId and applicationId scopes", () => {
    const resource = new AccessPolicyResource(
      {} as unknown as Cloudflare,
      POLICY_SCOPES,
    );
    assert.deepEqual(Object.keys(resource.scopes), [
      "accountId",
      "applicationId",
    ]);
    const scopeAccountId = scopeAt(resource.scopes, "accountId");
    assert.ok("config" in scopeAccountId);
    assert.equal(scopeAccountId.config, "accountId");
    const scopeAppId = scopeAt(resource.scopes, "applicationId");
    assert.ok("ref" in scopeAppId);
    assert.equal(scopeAppId.ref, "applicationId");
  });
});

// ─── AccessApplicationResource ───────────────────────────────────────────────

describe("AccessApplicationResource", () => {
  it("passes allowedIdps to create SDK call", async () => {
    const createSpy = mock.fn(() => ({
      id: "new-app-id",
      domain: "app.example.com",
      type: "self_hosted",
      name: "My App",
      session_duration: "24h",
      allowed_idps: ["idp-1", "idp-2"],
    }));
    const mockClient = {
      zeroTrust: {
        access: {
          applications: {
            list: mock.fn(() => ({ result: [] })),
            create: createSpy,
            update: mock.fn(),
          },
        },
      },
    };

    const resource = new AccessApplicationResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    await resource.create({
      kind: "AccessApplication",
      domain: "app.example.com",
      name: "My App",
      sessionDuration: "24h",
      allowedIdps: ["idp-1", "idp-2"],
    });

    assert.equal(createSpy.mock.callCount(), 1);
    const params = objectArg(createSpy.mock.calls, 0, 0);
    assert.ok("allowed_idps" in params, "params must include allowed_idps");
    assert.deepEqual(params.allowed_idps, ["idp-1", "idp-2"]);
  });

  it("passes allowedIdps to update SDK call", async () => {
    const updateSpy = mock.fn(() => ({
      id: "existing-app-id",
      domain: "app.example.com",
      type: "self_hosted",
      name: "My App",
      allowed_idps: ["idp-1"],
    }));
    const mockClient = {
      zeroTrust: {
        access: {
          applications: {
            list: mock.fn(() => ({ result: [] })),
            create: mock.fn(),
            update: updateSpy,
          },
        },
      },
    };

    const resource = new AccessApplicationResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    await resource.update("existing-app-id", {
      kind: "AccessApplication",
      domain: "app.example.com",
      name: "My App",
      allowedIdps: ["idp-1"],
    });

    assert.equal(updateSpy.mock.callCount(), 1);
    const params = objectArg(updateSpy.mock.calls, 0, 1);
    assert.ok("allowed_idps" in params, "params must include allowed_idps");
    assert.deepEqual(params.allowed_idps, ["idp-1"]);
  });

  it("omits allowedIdps from params when not in spec", async () => {
    const createSpy = mock.fn(() => ({
      id: "new-app-id",
      domain: "app.example.com",
      type: "self_hosted",
      name: "My App",
    }));
    const mockClient = {
      zeroTrust: {
        access: {
          applications: {
            list: mock.fn(() => ({ result: [] })),
            create: createSpy,
            update: mock.fn(),
          },
        },
      },
    };

    const resource = new AccessApplicationResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    await resource.create({
      kind: "AccessApplication",
      domain: "app.example.com",
      name: "My App",
    });

    const params = objectArg(createSpy.mock.calls, 0, 0);
    assert.ok(
      !("allowed_idps" in params),
      "allowed_idps should be absent when not in spec",
    );
  });

  it("declares accountId scope", () => {
    const resource = new AccessApplicationResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );
    const scopeEntry = scopeAt(resource.scopes, "accountId");
    assert.ok("config" in scopeEntry);
    assert.equal(scopeEntry.config, "accountId");
  });
});

// ─── IdentityProviderResource ────────────────────────────────────────────────

describe("IdentityProviderResource", () => {
  it("matches identity providers by name AND type in read", async () => {
    const mockIdps = [
      { id: "idp-1", name: "My Provider", type: "onetimepin" },
      { id: "idp-2", name: "My Provider", type: "google" },
    ];

    const mockClient = {
      zeroTrust: {
        identityProviders: {
          list: mock.fn(() => ({ result: mockIdps })),
          create: mock.fn(),
          update: mock.fn(),
        },
      },
    };

    const resource = new IdentityProviderResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "IdentityProvider",
      name: "My Provider",
      type: "google",
      config: {},
    });

    assert.ok(result !== undefined, "should find a matching IdP");
    assert.ok(isRecord(result));
    assert.equal(
      result.id,
      "idp-2",
      "should match the Google IdP, not the OTP one",
    );
  });

  it("returns undefined when name matches but type does not", async () => {
    const mockIdps = [{ id: "idp-1", name: "My Provider", type: "onetimepin" }];

    const mockClient = {
      zeroTrust: {
        identityProviders: {
          list: mock.fn(() => ({ result: mockIdps })),
          create: mock.fn(),
          update: mock.fn(),
        },
      },
    };

    const resource = new IdentityProviderResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "IdentityProvider",
      name: "My Provider",
      type: "google",
      config: {},
    });

    assert.equal(result, undefined, "should not match when type differs");
  });

  it("returns matching IdP when only one exists with that name", async () => {
    const mockIdps = [{ id: "idp-1", name: "Email OTP", type: "onetimepin" }];

    const mockClient = {
      zeroTrust: {
        identityProviders: {
          list: mock.fn(() => ({ result: mockIdps })),
          create: mock.fn(),
          update: mock.fn(),
        },
      },
    };

    const resource = new IdentityProviderResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "IdentityProvider",
      name: "Email OTP",
      type: "onetimepin",
      config: {},
    });

    assert.ok(result !== undefined);
    assert.ok(isRecord(result));
    assert.equal(result.id, "idp-1");
  });

  it("declares accountId scope", () => {
    const resource = new IdentityProviderResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );
    const scopeEntry = scopeAt(resource.scopes, "accountId");
    assert.ok("config" in scopeEntry);
    assert.equal(scopeEntry.config, "accountId");
  });
});

// ─── Codec tests ──────────────────────────────────────────────────────────────

describe("Codec bidirectional field mapping", () => {
  it("DnsRecord codec maps domain↔name, value↔content", () => {
    const resource = new DnsRecordResource({} as unknown as Cloudflare);

    // decode: spec → SDK fields
    const sdkFields = resource.codec.decode({
      kind: "DnsRecord",
      domain: "example.com",
      type: "A",
      value: "1.2.3.4",
      ttl: 300,
      proxied: false,
    });
    assert.ok(isRecord(sdkFields));
    assert.equal(sdkFields.name, "example.com");
    assert.equal(sdkFields.content, "1.2.3.4");

    // encode: state → normalised spec
    const normalised = resource.codec.encode({
      name: "example.com",
      content: "1.2.3.4",
      type: "A",
      ttl: 300,
      proxied: false,
    });
    assert.ok(isRecord(normalised));
    assert.equal(normalised.domain, "example.com");
    assert.equal(normalised.value, "1.2.3.4");
  });

  it("AccessApplication codec maps camelCase↔snake_case", () => {
    const resource = new AccessApplicationResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );

    // decode: spec → SDK fields
    const sdkFields = resource.codec.decode({
      kind: "AccessApplication",
      domain: "app.example.com",
      name: "My App",
      sessionDuration: "24h",
      autoRedirectToIdentity: true,
      allowedIdps: ["idp-1"],
    });
    assert.ok(isRecord(sdkFields));
    assert.equal(sdkFields.session_duration, "24h");
    assert.equal(sdkFields.auto_redirect_to_identity, true);
    assert.ok(Array.isArray(sdkFields.allowed_idps));

    // encode: state → normalised spec
    const normalised = resource.codec.encode({
      domain: "app.example.com",
      name: "My App",
      session_duration: "24h",
      auto_redirect_to_identity: true,
      allowed_idps: ["idp-1"],
    });
    assert.ok(isRecord(normalised));
    assert.equal(normalised.sessionDuration, "24h");
    assert.equal(normalised.autoRedirectToIdentity, true);
  });

  it("AccessPolicy codec maps include/exclude/require arrays", () => {
    const resource = new AccessPolicyResource(
      {} as unknown as Cloudflare,
      POLICY_SCOPES,
    );

    // decode: spec → SDK fields
    const sdkFields = resource.codec.decode({
      kind: "AccessPolicy",
      applicationId: "app-123",
      name: "Allow Team",
      decision: "allow",
      include: [{ email_domain: { domain: "example.com" } }],
      exclude: [{ ip: { ip: "10.0.0.0/8" } }],
    });
    assert.ok(isRecord(sdkFields));
    assert.ok(Array.isArray(sdkFields.include));
    assert.ok(Array.isArray(sdkFields.exclude));

    // encode: state → normalised spec
    const normalised = resource.codec.encode({
      name: "Allow Team",
      decision: "allow",
      include: [{ email_domain: { domain: "example.com" } }],
    });
    assert.ok(isRecord(normalised));
    assert.equal(normalised.name, "Allow Team");
    assert.equal(normalised.decision, "allow");
  });

  it("IdentityProvider codec maps name/type", () => {
    const resource = new IdentityProviderResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );

    // decode: spec → SDK fields
    const sdkFields = resource.codec.decode({
      kind: "IdentityProvider",
      name: "My OIDC",
      type: "oidc",
      config: { client_id: "abc" },
    });
    assert.ok(isRecord(sdkFields));
    assert.equal(sdkFields.name, "My OIDC");
    assert.equal(sdkFields.type, "oidc");

    // encode: state → normalised spec
    const normalised = resource.codec.encode({
      name: "My OIDC",
      type: "oidc",
    });
    assert.ok(isRecord(normalised));
    assert.equal(normalised.name, "My OIDC");
    assert.equal(normalised.type, "oidc");
  });

  it("PagesCustomDomain codec maps domain↔name", () => {
    const resource = new PagesCustomDomainResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );

    // decode: spec → SDK fields
    const sdkFields = resource.codec.decode({
      kind: "PagesCustomDomain",
      projectName: "my-site",
      domain: "www.example.com",
    });
    assert.ok(isRecord(sdkFields));
    assert.equal(sdkFields.name, "www.example.com");

    // encode: state → normalised spec
    const normalised = resource.codec.encode({
      name: "www.example.com",
      status: "active",
    });
    assert.ok(isRecord(normalised));
    assert.equal(normalised.domain, "www.example.com");
  });

  it("codecs pass through unrecognised input unchanged", () => {
    const resource = new DnsRecordResource({} as unknown as Cloudflare);
    const garbage = { totally: "wrong" };
    assert.strictEqual(resource.codec.decode(garbage), garbage);
    assert.strictEqual(resource.codec.encode(garbage), garbage);
  });
});

// ─── AccessGroup tests ────────────────────────────────────────────────────────

describe("AccessGroupResource", () => {
  it("queries groups by name in read", async () => {
    const listSpy = mock.fn(() => ({
      result: [
        { id: "grp-1", name: "Allow Devs", include: [] },
        { id: "grp-2", name: "Contractors", include: [] },
      ],
    }));
    const mockClient = {
      zeroTrust: {
        access: {
          groups: {
            list: listSpy,
            create: mock.fn(),
            update: mock.fn(),
          },
        },
      },
    };
    const resource = new AccessGroupResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "AccessGroup",
      name: "Allow Devs",
      include: [{ email_domain: { domain: "example.com" } }],
    });

    assert.ok(result !== undefined);
    assert.ok(isRecord(result));
    assert.equal(result.id, "grp-1");
  });

  it("returns undefined when group not found", async () => {
    const mockClient = {
      zeroTrust: {
        access: {
          groups: {
            list: mock.fn(() => ({ result: [] })),
            create: mock.fn(),
            update: mock.fn(),
          },
        },
      },
    };
    const resource = new AccessGroupResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "AccessGroup",
      name: "Missing Group",
      include: [],
    });

    assert.equal(result, undefined);
  });

  it("passes include/exclude to create", async () => {
    const createSpy = mock.fn(() => ({
      id: "grp-new",
      name: "Test Group",
      include: [],
    }));
    const mockClient = {
      zeroTrust: {
        access: {
          groups: {
            list: mock.fn(() => ({ result: [] })),
            create: createSpy,
            update: mock.fn(),
          },
        },
      },
    };
    const resource = new AccessGroupResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    await resource.create({
      kind: "AccessGroup",
      name: "Test Group",
      include: [{ email_domain: { domain: "example.com" } }],
      exclude: [{ ip: { ip: "10.0.0.0/8" } }],
    });

    assert.equal(createSpy.mock.callCount(), 1);
    const params = objectArg(createSpy.mock.calls, 0, 0);
    assert.ok(Array.isArray(params.include));
    assert.ok(Array.isArray(params.exclude));
  });

  it("declares accountId scope", () => {
    const resource = new AccessGroupResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );
    const scopeEntry = scopeAt(resource.scopes, "accountId");
    assert.ok("config" in scopeEntry);
    assert.equal(scopeEntry.config, "accountId");
  });
});

// ─── Tunnel tests ─────────────────────────────────────────────────────────────

describe("TunnelResource", () => {
  it("queries tunnels by name in read", async () => {
    const listSpy = mock.fn(() => ({
      result: [
        { id: "tun-1", name: "blog", status: "healthy" },
        { id: "tun-2", name: "api", status: "inactive" },
      ],
    }));
    const mockClient = {
      zeroTrust: {
        tunnels: {
          cloudflared: {
            list: listSpy,
            create: mock.fn(),
            edit: mock.fn(),
          },
        },
      },
    };
    const resource = new TunnelResource(asClient(mockClient), ACCOUNT_SCOPES);

    const result = await resource.read({
      kind: "Tunnel",
      name: "blog",
    });

    assert.ok(result !== undefined);
    assert.ok(isRecord(result));
    assert.equal(result.id, "tun-1");
  });

  it("returns undefined when tunnel not found", async () => {
    const mockClient = {
      zeroTrust: {
        tunnels: {
          cloudflared: {
            list: mock.fn(() => ({ result: [] })),
            create: mock.fn(),
            edit: mock.fn(),
          },
        },
      },
    };
    const resource = new TunnelResource(asClient(mockClient), ACCOUNT_SCOPES);

    const result = await resource.read({ kind: "Tunnel", name: "missing" });
    assert.equal(result, undefined);
  });

  it("passes name and config_src to create", async () => {
    const createSpy = mock.fn(() => ({
      id: "tun-new",
      name: "my-tunnel",
      status: "inactive",
    }));
    const mockClient = {
      zeroTrust: {
        tunnels: {
          cloudflared: {
            list: mock.fn(() => ({ result: [] })),
            create: createSpy,
            edit: mock.fn(),
          },
        },
      },
    };
    const resource = new TunnelResource(asClient(mockClient), ACCOUNT_SCOPES);

    await resource.create({
      kind: "Tunnel",
      name: "my-tunnel",
      configSrc: "cloudflare",
    });

    assert.equal(createSpy.mock.callCount(), 1);
    const params = objectArg(createSpy.mock.calls, 0, 0);
    assert.equal(params.name, "my-tunnel");
    assert.equal(params.config_src, "cloudflare");
  });

  it("declares accountId scope", () => {
    const resource = new TunnelResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );
    const scopeEntry = scopeAt(resource.scopes, "accountId");
    assert.ok("config" in scopeEntry);
    assert.equal(scopeEntry.config, "accountId");
  });
});
