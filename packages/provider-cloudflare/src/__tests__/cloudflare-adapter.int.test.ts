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
} from "@infrasync-org/core/provider";
import { isRecord } from "@infrasync-org/core/resource";
import { AccessPolicyResource } from "../access-policy.js";
import { AccessApplicationResource } from "../access-app.js";
import { IdentityProviderResource } from "../identity-provider.js";
import { PagesCustomDomainResource } from "../pages-domain.js";
import { DnsRecordResource } from "../dns-record.js";
import { AccessGroupResource } from "../access-group.js";
import { TunnelResource } from "../tunnel.js";
import { ZoneResource } from "../zone.js";
import { R2BucketResource } from "../r2-bucket.js";
import { WorkerRouteResource } from "../worker-route.js";
import { PagesProjectResource } from "../pages-project.js";
import { EmailRoutingRuleResource } from "../email-routing-rule.js";

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

// ─── ZoneResource tests ───────────────────────────────────────────────────────

describe("ZoneResource", () => {
  it("queries zones by name in read", async () => {
    const listSpy = mock.fn(() => ({
      result: [
        { id: "zone-1", name: "example.com", status: "active", type: "full" },
        { id: "zone-2", name: "other.com", status: "active", type: "full" },
      ],
    }));
    const mockClient = {
      zones: {
        list: listSpy,
        create: mock.fn(),
        edit: mock.fn(),
      },
    };
    const resource = new ZoneResource(asClient(mockClient), ACCOUNT_SCOPES);

    const result = await resource.read({
      kind: "Zone",
      name: "example.com",
    });

    assert.ok(result !== undefined);
    assert.ok(isRecord(result));
    assert.equal(result.id, "zone-1");
    assert.equal(listSpy.mock.callCount(), 1);
    const params = objectArg(listSpy.mock.calls, 0, 0);
    assert.equal(params.name, "example.com");
  });

  it("returns undefined when zone not found", async () => {
    const mockClient = {
      zones: {
        list: mock.fn(() => ({ result: [] })),
        create: mock.fn(),
        edit: mock.fn(),
      },
    };
    const resource = new ZoneResource(asClient(mockClient), ACCOUNT_SCOPES);

    const result = await resource.read({
      kind: "Zone",
      name: "missing.com",
    });

    assert.equal(result, undefined);
  });

  it("passes name and type to create SDK call", async () => {
    const createSpy = mock.fn(() => ({
      id: "zone-new",
      name: "newzone.com",
      status: "pending",
      type: "full",
    }));
    const mockClient = {
      zones: {
        list: mock.fn(() => ({ result: [] })),
        create: createSpy,
        edit: mock.fn(),
      },
    };
    const resource = new ZoneResource(asClient(mockClient), ACCOUNT_SCOPES);

    await resource.create({
      kind: "Zone",
      name: "newzone.com",
      type: "full",
    });

    assert.equal(createSpy.mock.callCount(), 1);
    const params = objectArg(createSpy.mock.calls, 0, 0);
    assert.equal(params.name, "newzone.com");
    assert.equal(params.type, "full");
  });

  it("passes paused flag to edit after create when present", async () => {
    const createSpy = mock.fn(() => ({
      id: "zone-new",
      name: "newzone.com",
      status: "pending",
      type: "full",
    }));
    const editSpy = mock.fn(() => ({
      id: "zone-new",
      name: "newzone.com",
      status: "pending",
      paused: true,
    }));
    const mockClient = {
      zones: {
        list: mock.fn(() => ({ result: [] })),
        create: createSpy,
        edit: editSpy,
      },
    };
    const resource = new ZoneResource(asClient(mockClient), ACCOUNT_SCOPES);

    await resource.create({
      kind: "Zone",
      name: "newzone.com",
      paused: true,
    });

    assert.equal(editSpy.mock.callCount(), 1);
    const params = objectArg(editSpy.mock.calls, 0, 0);
    assert.equal(params.zone_id, "zone-new");
    assert.equal(params.paused, true);
  });

  it("declares accountId scope", () => {
    const resource = new ZoneResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );
    const scopeEntry = scopeAt(resource.scopes, "accountId");
    assert.ok("config" in scopeEntry);
    assert.equal(scopeEntry.config, "accountId");
  });
});

// ─── R2BucketResource tests ───────────────────────────────────────────────────

describe("R2BucketResource", () => {
  it("queries buckets by name_contains in read", async () => {
    const listSpy = mock.fn(() => ({
      buckets: [
        { name: "my-bucket", location: "wnam", storage_class: "Standard" },
        {
          name: "my-backup",
          location: "enam",
          storage_class: "InfrequentAccess",
        },
      ],
    }));
    const mockClient = {
      r2: {
        buckets: {
          list: listSpy,
          create: mock.fn(),
          edit: mock.fn(),
        },
      },
    };
    const resource = new R2BucketResource(asClient(mockClient), ACCOUNT_SCOPES);

    const result = await resource.read({
      kind: "R2Bucket",
      name: "my-bucket",
    });

    assert.ok(result !== undefined);
    assert.ok(isRecord(result));
    assert.equal(result.name, "my-bucket");
    assert.equal(listSpy.mock.callCount(), 1);
    const params = objectArg(listSpy.mock.calls, 0, 0);
    assert.equal(params.name_contains, "my-bucket");
  });

  it("returns undefined when bucket not found", async () => {
    const mockClient = {
      r2: {
        buckets: {
          list: mock.fn(() => ({ buckets: [] })),
          create: mock.fn(),
          edit: mock.fn(),
        },
      },
    };
    const resource = new R2BucketResource(asClient(mockClient), ACCOUNT_SCOPES);

    const result = await resource.read({
      kind: "R2Bucket",
      name: "missing-bucket",
    });

    assert.equal(result, undefined);
  });

  it("passes location and storageClass to create", async () => {
    const createSpy = mock.fn(() => ({
      name: "new-bucket",
      location: "wnam",
      storage_class: "Standard",
    }));
    const mockClient = {
      r2: {
        buckets: {
          list: mock.fn(() => ({ buckets: [] })),
          create: createSpy,
          edit: mock.fn(),
        },
      },
    };
    const resource = new R2BucketResource(asClient(mockClient), ACCOUNT_SCOPES);

    await resource.create({
      kind: "R2Bucket",
      name: "new-bucket",
      location: "wnam",
      storageClass: "Standard",
    });

    assert.equal(createSpy.mock.callCount(), 1);
    const params = objectArg(createSpy.mock.calls, 0, 0);
    assert.equal(params.name, "new-bucket");
    assert.equal(params.locationHint, "wnam");
    assert.equal(params.storageClass, "Standard");
  });

  it("declares accountId scope", () => {
    const resource = new R2BucketResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );
    const scopeEntry = scopeAt(resource.scopes, "accountId");
    assert.ok("config" in scopeEntry);
    assert.equal(scopeEntry.config, "accountId");
  });
});

// ─── WorkerRouteResource tests ────────────────────────────────────────────────

describe("WorkerRouteResource", () => {
  it("queries zones then routes by pattern in read", async () => {
    const zonesListSpy = mock.fn(() => ({
      result: [{ id: "zone-1", name: "example.com" }],
    }));
    const routesListSpy = mock.fn(() => ({
      result: [
        {
          id: "route-1",
          pattern: "example.com/*",
          script: "handler",
        },
        {
          id: "route-2",
          pattern: "api.example.com/*",
          script: "api-handler",
        },
      ],
    }));
    const mockClient = {
      zones: {
        list: zonesListSpy,
      },
      workers: {
        routes: {
          list: routesListSpy,
          create: mock.fn(),
          update: mock.fn(),
        },
      },
    };
    const resource = new WorkerRouteResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "WorkerRoute",
      pattern: "example.com/*",
      script: "handler",
    });

    assert.ok(result !== undefined);
    assert.ok(isRecord(result));
    assert.equal(result.pattern, "example.com/*");
    assert.equal(routesListSpy.mock.callCount(), 1);
  });

  it("returns undefined when route not found", async () => {
    const mockClient = {
      zones: {
        list: mock.fn(() => ({
          result: [{ id: "zone-1", name: "example.com" }],
        })),
      },
      workers: {
        routes: {
          list: mock.fn(() => ({ result: [] })),
          create: mock.fn(),
          update: mock.fn(),
        },
      },
    };
    const resource = new WorkerRouteResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "WorkerRoute",
      pattern: "missing.com/*",
      script: "handler",
    });

    assert.equal(result, undefined);
  });

  it("queries zone then creates route with pattern and script", async () => {
    const zonesListSpy = mock.fn(() => ({
      result: [{ id: "zone-1", name: "example.com" }],
    }));
    const createSpy = mock.fn(() => ({
      id: "route-new",
      pattern: "example.com/*",
      script: "new-handler",
    }));
    const mockClient = {
      zones: {
        list: zonesListSpy,
      },
      workers: {
        routes: {
          list: mock.fn(() => ({ result: [] })),
          create: createSpy,
          update: mock.fn(),
        },
      },
    };
    const resource = new WorkerRouteResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    await resource.create({
      kind: "WorkerRoute",
      pattern: "example.com/*",
      script: "new-handler",
    });

    assert.equal(createSpy.mock.callCount(), 1);
    const params = objectArg(createSpy.mock.calls, 0, 0);
    assert.equal(params.pattern, "example.com/*");
    assert.equal(params.script, "new-handler");
    assert.equal(params.zone_id, "zone-1");
  });

  it("declares accountId scope", () => {
    const resource = new WorkerRouteResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );
    const scopeEntry = scopeAt(resource.scopes, "accountId");
    assert.ok("config" in scopeEntry);
    assert.equal(scopeEntry.config, "accountId");
  });
});

// ─── PagesProjectResource tests ───────────────────────────────────────────────

describe("PagesProjectResource", () => {
  it("calls pages.projects.get in read", async () => {
    const getSpy = mock.fn(() => ({
      id: "proj-1",
      name: "my-site",
      subdomain: "my-site.pages.dev",
      production_branch: "main",
    }));
    const mockClient = {
      pages: {
        projects: {
          get: getSpy,
          create: mock.fn(),
          edit: mock.fn(),
        },
      },
    };
    const resource = new PagesProjectResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "PagesProject",
      name: "my-site",
    });

    assert.ok(result !== undefined);
    assert.ok(isRecord(result));
    assert.equal(result.name, "my-site");
    assert.equal(getSpy.mock.callCount(), 1);
    assert.equal(stringArg(getSpy.mock.calls, 0, 0), "my-site");
  });

  it("returns undefined when project not found", async () => {
    const getSpy = mock.fn(() => {
      throw new Error("404");
    });
    const mockClient = {
      pages: {
        projects: {
          get: getSpy,
          create: mock.fn(),
          edit: mock.fn(),
        },
      },
    };
    const resource = new PagesProjectResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "PagesProject",
      name: "missing-site",
    });

    assert.equal(result, undefined);
  });

  it("passes name and buildConfig to create", async () => {
    const createSpy = mock.fn(() => ({
      id: "proj-new",
      name: "new-site",
      subdomain: "new-site.pages.dev",
    }));
    const mockClient = {
      pages: {
        projects: {
          get: mock.fn(),
          create: createSpy,
          edit: mock.fn(),
        },
      },
    };
    const resource = new PagesProjectResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    await resource.create({
      kind: "PagesProject",
      name: "new-site",
      buildConfig: {
        buildCommand: "npm run build",
        destinationDir: "dist",
        buildCaching: true,
      },
    });

    assert.equal(createSpy.mock.callCount(), 1);
    const params = objectArg(createSpy.mock.calls, 0, 0);
    assert.equal(params.name, "new-site");
    assert.ok("build_config" in params);
    const buildConfig = params.build_config;
    assert.ok(isRecord(buildConfig));
    assert.equal(buildConfig.build_command, "npm run build");
    assert.equal(buildConfig.destination_dir, "dist");
  });

  it("declares accountId scope", () => {
    const resource = new PagesProjectResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );
    const scopeEntry = scopeAt(resource.scopes, "accountId");
    assert.ok("config" in scopeEntry);
    assert.equal(scopeEntry.config, "accountId");
  });
});

// ─── EmailRoutingRuleResource tests ───────────────────────────────────────────

describe("EmailRoutingRuleResource", () => {
  it("queries zones then rules by name in read", async () => {
    const zonesListSpy = mock.fn(() => ({
      result: [{ id: "zone-1", name: "example.com" }],
    }));
    const rulesListSpy = mock.fn(() => ({
      result: [
        {
          id: "rule-1",
          name: "Catch All",
          enabled: true,
          actions: [{ type: "forward", value: ["admin@example.com"] }],
          matchers: [{ type: "all" }],
        },
        {
          id: "rule-2",
          name: "Support",
          enabled: true,
          actions: [{ type: "forward", value: ["support@example.com"] }],
          matchers: [{ type: "literal", value: "support@example.com" }],
        },
      ],
    }));
    const mockClient = {
      zones: {
        list: zonesListSpy,
      },
      emailRouting: {
        rules: {
          list: rulesListSpy,
          create: mock.fn(),
          update: mock.fn(),
        },
      },
    };
    const resource = new EmailRoutingRuleResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "EmailRoutingRule",
      zoneName: "example.com",
      name: "Catch All",
      actions: [{ type: "forward", value: ["admin@example.com"] }],
      matchers: [{ type: "all" }],
    });

    assert.ok(result !== undefined);
    assert.ok(isRecord(result));
    assert.equal(result.name, "Catch All");
    assert.equal(rulesListSpy.mock.callCount(), 1);
  });

  it("returns undefined when rule not found", async () => {
    const mockClient = {
      zones: {
        list: mock.fn(() => ({
          result: [{ id: "zone-1", name: "example.com" }],
        })),
      },
      emailRouting: {
        rules: {
          list: mock.fn(() => ({ result: [] })),
          create: mock.fn(),
          update: mock.fn(),
        },
      },
    };
    const resource = new EmailRoutingRuleResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    const result = await resource.read({
      kind: "EmailRoutingRule",
      zoneName: "example.com",
      name: "Missing",
      actions: [{ type: "forward", value: ["test@example.com"] }],
      matchers: [{ type: "all" }],
    });

    assert.equal(result, undefined);
  });

  it("passes actions and matchers to create", async () => {
    const zonesListSpy = mock.fn(() => ({
      result: [{ id: "zone-1", name: "example.com" }],
    }));
    const createSpy = mock.fn(() => ({
      id: "rule-new",
      name: "New Rule",
      enabled: true,
      actions: [{ type: "forward", value: ["new@example.com"] }],
      matchers: [{ type: "literal", value: "info@example.com" }],
    }));
    const mockClient = {
      zones: {
        list: zonesListSpy,
      },
      emailRouting: {
        rules: {
          list: mock.fn(() => ({ result: [] })),
          create: createSpy,
          update: mock.fn(),
        },
      },
    };
    const resource = new EmailRoutingRuleResource(
      asClient(mockClient),
      ACCOUNT_SCOPES,
    );

    await resource.create({
      kind: "EmailRoutingRule",
      zoneName: "example.com",
      name: "New Rule",
      actions: [{ type: "forward", value: ["new@example.com"] }],
      matchers: [{ type: "literal", value: "info@example.com" }],
      enabled: true,
    });

    assert.equal(createSpy.mock.callCount(), 1);
    const params = objectArg(createSpy.mock.calls, 0, 0);
    assert.equal(params.name, "New Rule");
    assert.ok(Array.isArray(params.actions));
    assert.ok(Array.isArray(params.matchers));
  });

  it("declares accountId scope", () => {
    const resource = new EmailRoutingRuleResource(
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

  it("Zone codec passes through name, type, paused", () => {
    const resource = new ZoneResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );

    // decode: spec → SDK fields
    const sdkFields = resource.codec.decode({
      kind: "Zone",
      name: "example.com",
      type: "full",
      paused: false,
    });
    assert.ok(isRecord(sdkFields));
    assert.equal(sdkFields.name, "example.com");
    assert.equal(sdkFields.type, "full");
    assert.equal(sdkFields.paused, false);

    // encode: state → normalised spec
    const normalised = resource.codec.encode({
      name: "example.com",
      type: "full",
      paused: false,
    });
    assert.ok(isRecord(normalised));
    assert.equal(normalised.kind, "Zone");
    assert.equal(normalised.name, "example.com");
    assert.equal(normalised.type, "full");
  });

  it("R2Bucket codec maps storageClass↔storage_class, location↔location", () => {
    const resource = new R2BucketResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );

    // decode: spec → SDK fields
    const sdkFields = resource.codec.decode({
      kind: "R2Bucket",
      name: "my-bucket",
      location: "wnam",
      storageClass: "Standard",
      jurisdiction: "default",
    });
    assert.ok(isRecord(sdkFields));
    assert.equal(sdkFields.name, "my-bucket");
    assert.equal(sdkFields.location, "wnam");
    assert.equal(sdkFields.storage_class, "Standard");
    assert.equal(sdkFields.jurisdiction, "default");

    // encode: state → normalised spec
    const normalised = resource.codec.encode({
      name: "my-bucket",
      location: "wnam",
      storage_class: "Standard",
      jurisdiction: "default",
    });
    assert.ok(isRecord(normalised));
    assert.equal(normalised.kind, "R2Bucket");
    assert.equal(normalised.storageClass, "Standard");
  });

  it("WorkerRoute codec passes through pattern and script", () => {
    const resource = new WorkerRouteResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );

    // decode: spec → SDK fields
    const sdkFields = resource.codec.decode({
      kind: "WorkerRoute",
      pattern: "example.com/*",
      script: "handler",
    });
    assert.ok(isRecord(sdkFields));
    assert.equal(sdkFields.pattern, "example.com/*");
    assert.equal(sdkFields.script, "handler");

    // encode: state → normalised spec
    const normalised = resource.codec.encode({
      pattern: "example.com/*",
      script: "handler",
    });
    assert.ok(isRecord(normalised));
    assert.equal(normalised.kind, "WorkerRoute");
    assert.equal(normalised.pattern, "example.com/*");
    assert.equal(normalised.script, "handler");
  });

  it("PagesProject codec maps buildConfig (camelCase↔snake_case)", () => {
    const resource = new PagesProjectResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );

    // decode: spec → SDK fields
    const sdkFields = resource.codec.decode({
      kind: "PagesProject",
      name: "my-site",
      productionBranch: "main",
      buildConfig: {
        buildCommand: "npm run build",
        destinationDir: "dist",
        buildCaching: true,
      },
    });
    assert.ok(isRecord(sdkFields));
    assert.equal(sdkFields.name, "my-site");
    assert.equal(sdkFields.production_branch, "main");
    const buildConfig = sdkFields.build_config;
    assert.ok(isRecord(buildConfig));
    assert.equal(buildConfig.build_command, "npm run build");
    assert.equal(buildConfig.destination_dir, "dist");
    assert.equal(buildConfig.build_caching, true);

    // encode: state → normalised spec
    const normalised = resource.codec.encode({
      name: "my-site",
      production_branch: "main",
      build_config: {
        build_command: "npm run build",
        destination_dir: "dist",
        build_caching: true,
      },
    });
    assert.ok(isRecord(normalised));
    assert.equal(normalised.kind, "PagesProject");
    assert.equal(normalised.productionBranch, "main");
    const normalisedBuildConfig = normalised.buildConfig;
    assert.ok(isRecord(normalisedBuildConfig));
    assert.equal(normalisedBuildConfig.buildCommand, "npm run build");
    assert.equal(normalisedBuildConfig.destinationDir, "dist");
  });

  it("EmailRoutingRule codec narrows actions/matchers type enums", () => {
    const resource = new EmailRoutingRuleResource(
      {} as unknown as Cloudflare,
      ACCOUNT_SCOPES,
    );

    // decode: spec → SDK fields
    const sdkFields = resource.codec.decode({
      kind: "EmailRoutingRule",
      actions: [{ type: "forward", value: ["admin@example.com"] }],
      matchers: [{ type: "literal", value: "info@example.com", field: "to" }],
      enabled: true,
    });
    assert.ok(isRecord(sdkFields));
    assert.ok(Array.isArray(sdkFields.actions));
    assert.ok(Array.isArray(sdkFields.matchers));
    const action = at(sdkFields.actions as unknown[], 0);
    assert.ok(isRecord(action));
    assert.equal(action.type, "forward");

    // encode: state → normalised spec with type narrowing
    const normalised = resource.codec.encode({
      actions: [{ type: "forward", value: ["admin@example.com"] }],
      matchers: [{ type: "literal", value: "info@example.com", field: "to" }],
      enabled: true,
    });
    assert.ok(isRecord(normalised));
    assert.equal(normalised.kind, "EmailRoutingRule");
    assert.ok(Array.isArray(normalised.actions));
    assert.ok(Array.isArray(normalised.matchers));
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
