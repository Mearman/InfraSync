import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@microsoft/microsoft-graph-client";
import { ProviderApiError } from "@infrasync-org/core/errors";
import { ResolvedScopes } from "@infrasync-org/core/provider";
import {
  microsoftEntraIdConfigSchema,
  MicrosoftEntraIdProvider,
  userSpecSchema,
  domainFederationConfigurationSpecSchema,
  createMicrosoftEntraIdHandle,
  UserResource,
  DomainFederationConfigurationResource,
} from "../index.js";

// ─── Mock helpers ────────────────────────────────────────────────────────────

interface GraphRequestMockOptions {
  readonly getResponses?: readonly unknown[];
  readonly postResponses?: readonly unknown[];
  readonly patchResponses?: readonly unknown[];
}

interface GraphRequestRecorder {
  readonly apiCalls: string[];
  readonly selectCalls: (string | readonly string[])[];
  readonly getCallCount: { value: number };
  readonly postBodies: unknown[];
  readonly patchBodies: unknown[];
}

/**
 * Build a stub Graph `Client` that records calls and returns scripted
 * responses. The fluent `.api(path).select(...).get()/.post(body)/.patch(body)`
 * chain is preserved.
 */
function buildMockClient(opts: GraphRequestMockOptions): {
  client: Client;
  recorder: GraphRequestRecorder;
} {
  const apiCalls: string[] = [];
  const selectCalls: (string | readonly string[])[] = [];
  const getCallCount = { value: 0 };
  const postBodies: unknown[] = [];
  const patchBodies: unknown[] = [];

  const getResponses = [...(opts.getResponses ?? [])];
  const postResponses = [...(opts.postResponses ?? [])];
  const patchResponses = [...(opts.patchResponses ?? [])];

  function nextResponse(queue: unknown[], op: string): unknown {
    if (queue.length === 0) {
      throw new Error(`Mock ran out of ${op} responses`);
    }
    return queue.shift();
  }

  const request = {
    select(properties: string | readonly string[]) {
      selectCalls.push(properties);
      return request;
    },
    async get(): Promise<unknown> {
      getCallCount.value += 1;
      return nextResponse(getResponses, "GET");
    },
    async post(body: unknown): Promise<unknown> {
      postBodies.push(body);
      return nextResponse(postResponses, "POST");
    },
    async patch(body: unknown): Promise<unknown> {
      patchBodies.push(body);
      return nextResponse(patchResponses, "PATCH");
    },
  };

  const client = {
    api(path: string) {
      apiCalls.push(path);
      return request;
    },
  } as unknown as Client;

  return {
    client,
    recorder: { apiCalls, selectCalls, getCallCount, postBodies, patchBodies },
  };
}

const VALID_USER_SPEC = {
  kind: "User" as const,
  userPrincipalName: "alice@example.com",
  displayName: "Alice",
  mailNickname: "alice",
  accountEnabled: true,
  usageLocation: "GB",
  userType: "Member" as const,
  passwordProfile: { password: "redacted-in-test" },
};

const FULL_USER_RESPONSE = {
  id: "user-1",
  userPrincipalName: "alice@example.com",
  displayName: "Alice",
  mailNickname: "alice",
  accountEnabled: true,
  usageLocation: "GB",
  userType: "Member",
};

const VALID_FEDERATION_SPEC = {
  kind: "DomainFederationConfiguration" as const,
  domain: "example.com",
  issuerUri: "https://idp.example.com/",
  displayName: "Example IdP",
  activeSignInUri: "https://idp.example.com/active",
  passiveSignInUri: "https://idp.example.com/passive",
  signOutUri: "https://idp.example.com/signout",
  signingCertificate: "MIIB-base64-cert",
  preferredAuthenticationProtocol: "saml" as const,
};

const FULL_FEDERATION_RESPONSE = {
  id: "fed-1",
  displayName: "Example IdP",
  issuerUri: "https://idp.example.com/",
  activeSignInUri: "https://idp.example.com/active",
  passiveSignInUri: "https://idp.example.com/passive",
  signOutUri: "https://idp.example.com/signout",
  signingCertificate: "MIIB-base64-cert",
  preferredAuthenticationProtocol: "saml",
};

describe("Microsoft Entra ID adapter", () => {
  // ─── Config schema ─────────────────────────────────────────────────────────

  it("accepts a device-code config", () => {
    const result = microsoftEntraIdConfigSchema.safeParse({
      kind: "device-code",
      tenantId: "tenant-1",
      clientId: "client-1",
    });
    assert.ok(result.success);
  });

  it("accepts a client-credentials config", () => {
    const result = microsoftEntraIdConfigSchema.safeParse({
      kind: "client-credentials",
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "shh",
    });
    assert.ok(result.success);
  });

  it("rejects client-credentials config without clientSecret", () => {
    const result = microsoftEntraIdConfigSchema.safeParse({
      kind: "client-credentials",
      tenantId: "tenant-1",
      clientId: "client-1",
    });
    assert.ok(!result.success);
  });

  it("rejects unknown auth kind", () => {
    const result = microsoftEntraIdConfigSchema.safeParse({
      kind: "interactive",
      tenantId: "tenant-1",
      clientId: "client-1",
    });
    assert.ok(!result.success);
  });

  // ─── Provider registry ────────────────────────────────────────────────────

  it("provider lists supported kinds", () => {
    const provider = new MicrosoftEntraIdProvider();
    assert.deepEqual(provider.supportedKinds(), [
      "User",
      "DomainFederationConfiguration",
    ]);
  });

  it("provider creates handlers after connect", async () => {
    const provider = new MicrosoftEntraIdProvider();
    await provider.connect({
      kind: "client-credentials",
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "shh",
    });
    for (const kind of provider.supportedKinds()) {
      const handler = provider.resourceHandler(kind, ResolvedScopes.empty);
      assert.equal(handler.kind, kind);
    }
    await provider.disconnect();
  });

  it("provider rejects unknown kind after connect", async () => {
    const provider = new MicrosoftEntraIdProvider();
    await provider.connect({
      kind: "client-credentials",
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "shh",
    });
    assert.throws(
      () => provider.resourceHandler("Unknown", ResolvedScopes.empty),
      /No resource registered/,
    );
    await provider.disconnect();
  });

  it("provider throws when handler is requested before connect", () => {
    const provider = new MicrosoftEntraIdProvider();
    assert.throws(
      () => provider.resourceHandler("User", ResolvedScopes.empty),
      /not connected/,
    );
  });

  it("provider rejects invalid config", async () => {
    const provider = new MicrosoftEntraIdProvider();
    await assert.rejects(
      () => provider.connect({ kind: "client-credentials" }),
      /config validation failed/,
    );
  });

  // ─── User spec ────────────────────────────────────────────────────────────

  it("parses a valid User spec", () => {
    const result = userSpecSchema.safeParse({
      kind: "User",
      userPrincipalName: "alice@example.com",
      displayName: "Alice Example",
      mailNickname: "alice",
      accountEnabled: true,
      usageLocation: "GB",
      userType: "Member",
      passwordProfile: {
        password: "redacted-in-test",
        forceChangePasswordNextSignIn: true,
      },
    });
    assert.ok(result.success);
    assert.equal(result.data.userType, "Member");
  });

  it("defaults User userType to Member", () => {
    const result = userSpecSchema.safeParse({
      kind: "User",
      userPrincipalName: "bob@example.com",
      displayName: "Bob",
      mailNickname: "bob",
      accountEnabled: true,
      usageLocation: "GB",
      passwordProfile: { password: "redacted-in-test" },
    });
    assert.ok(result.success);
    assert.equal(result.data.userType, "Member");
  });

  it("rejects User with non-ISO usageLocation", () => {
    const result = userSpecSchema.safeParse({
      kind: "User",
      userPrincipalName: "alice@example.com",
      displayName: "Alice",
      mailNickname: "alice",
      accountEnabled: true,
      usageLocation: "GBR",
      passwordProfile: { password: "redacted-in-test" },
    });
    assert.ok(!result.success);
  });

  it("rejects User without passwordProfile", () => {
    const result = userSpecSchema.safeParse({
      kind: "User",
      userPrincipalName: "alice@example.com",
      displayName: "Alice",
      mailNickname: "alice",
      accountEnabled: true,
      usageLocation: "GB",
    });
    assert.ok(!result.success);
  });

  it("rejects extra fields on User spec", () => {
    const result = userSpecSchema.safeParse({
      kind: "User",
      userPrincipalName: "alice@example.com",
      displayName: "Alice",
      mailNickname: "alice",
      accountEnabled: true,
      usageLocation: "GB",
      passwordProfile: { password: "redacted-in-test" },
      unexpected: "field",
    });
    assert.ok(!result.success);
  });

  // ─── DomainFederationConfiguration spec ───────────────────────────────────

  it("parses a valid DomainFederationConfiguration spec", () => {
    const result = domainFederationConfigurationSpecSchema.safeParse({
      kind: "DomainFederationConfiguration",
      domain: "example.com",
      issuerUri: "https://idp.example.com/",
      displayName: "Example IdP",
      activeSignInUri: "https://idp.example.com/active",
      passiveSignInUri: "https://idp.example.com/passive",
      metadataExchangeUri: "https://idp.example.com/mex",
      signOutUri: "https://idp.example.com/signout",
      signingCertificate: "MIIB-base64-cert",
      preferredAuthenticationProtocol: "saml",
    });
    assert.ok(result.success);
    assert.equal(result.data.preferredAuthenticationProtocol, "saml");
  });

  it("defaults DomainFederationConfiguration protocol to saml", () => {
    const result = domainFederationConfigurationSpecSchema.safeParse({
      kind: "DomainFederationConfiguration",
      domain: "example.com",
      issuerUri: "https://idp.example.com/",
      displayName: "Example IdP",
      activeSignInUri: "https://idp.example.com/active",
      passiveSignInUri: "https://idp.example.com/passive",
      signOutUri: "https://idp.example.com/signout",
      signingCertificate: "MIIB-base64-cert",
    });
    assert.ok(result.success);
    assert.equal(result.data.preferredAuthenticationProtocol, "saml");
  });

  it("rejects DomainFederationConfiguration with invalid URI", () => {
    const result = domainFederationConfigurationSpecSchema.safeParse({
      kind: "DomainFederationConfiguration",
      domain: "example.com",
      issuerUri: "not-a-url",
      displayName: "Example IdP",
      activeSignInUri: "https://idp.example.com/active",
      passiveSignInUri: "https://idp.example.com/passive",
      signOutUri: "https://idp.example.com/signout",
      signingCertificate: "MIIB-base64-cert",
    });
    assert.ok(!result.success);
  });

  it("rejects unknown preferredAuthenticationProtocol", () => {
    const result = domainFederationConfigurationSpecSchema.safeParse({
      kind: "DomainFederationConfiguration",
      domain: "example.com",
      issuerUri: "https://idp.example.com/",
      displayName: "Example IdP",
      activeSignInUri: "https://idp.example.com/active",
      passiveSignInUri: "https://idp.example.com/passive",
      signOutUri: "https://idp.example.com/signout",
      signingCertificate: "MIIB-base64-cert",
      preferredAuthenticationProtocol: "oauth",
    });
    assert.ok(!result.success);
  });

  // ─── Typed handle ─────────────────────────────────────────────────────────

  it("typed handle registers User and DomainFederationConfiguration", () => {
    const registered: { kind: string; name: string }[] = [];
    const entra = createMicrosoftEntraIdHandle(
      "entra",
      "microsoft-entra-id",
      (handle) => {
        registered.push({ kind: handle.kind, name: handle.name });
      },
    );

    const userHandle = entra.user("alice", {
      kind: "User",
      userPrincipalName: "alice@example.com",
      displayName: "Alice",
      mailNickname: "alice",
      accountEnabled: true,
      usageLocation: "GB",
      userType: "Member",
      passwordProfile: { password: "redacted-in-test" },
    });
    assert.equal(userHandle.kind, "User");
    assert.equal(userHandle.ref.id.resource, "alice");
    assert.equal(userHandle.ref.userPrincipalName.path, "userPrincipalName");

    const federationHandle = entra.domainFederationConfiguration("idp", {
      kind: "DomainFederationConfiguration",
      domain: "example.com",
      issuerUri: "https://idp.example.com/",
      displayName: "Example IdP",
      activeSignInUri: "https://idp.example.com/active",
      passiveSignInUri: "https://idp.example.com/passive",
      signOutUri: "https://idp.example.com/signout",
      signingCertificate: "MIIB-base64-cert",
      preferredAuthenticationProtocol: "saml",
      federatedIdpMfaBehavior: "acceptIfMfaDoneByFederatedIdp",
    });
    assert.equal(federationHandle.kind, "DomainFederationConfiguration");
    assert.equal(federationHandle.ref.domain.path, "domain");

    assert.deepEqual(registered, [
      { kind: "User", name: "alice" },
      { kind: "DomainFederationConfiguration", name: "idp" },
    ]);
  });
});

// ─── UserResource adapter behaviour ──────────────────────────────────────────

describe("UserResource (finding #2, #3, #7)", () => {
  it("read() forces $select for the full convergence set", async () => {
    const { client, recorder } = buildMockClient({
      getResponses: [FULL_USER_RESPONSE],
    });
    const resource = new UserResource(client);

    const state = await resource.read(VALID_USER_SPEC);

    assert.equal(recorder.selectCalls.length, 1);
    const selected = recorder.selectCalls[0];
    if (selected === undefined || typeof selected === "string") {
      throw new Error("expected select() to receive an array");
    }
    const sortedSelected = [...selected].sort();
    assert.deepEqual(
      sortedSelected,
      [
        "accountEnabled",
        "displayName",
        "id",
        "mailNickname",
        "userPrincipalName",
        "userType",
        "usageLocation",
      ].sort(),
    );
    assert.deepEqual(state, FULL_USER_RESPONSE);
  });

  it("create() re-fetches with $select after POST", async () => {
    const { client, recorder } = buildMockClient({
      postResponses: [{ id: "user-1" }],
      getResponses: [FULL_USER_RESPONSE],
    });
    const resource = new UserResource(client);

    const state = await resource.create(VALID_USER_SPEC);

    assert.equal(recorder.apiCalls.length, 2);
    assert.equal(recorder.apiCalls[0], "/users");
    assert.equal(recorder.apiCalls[1], "/users/user-1");
    assert.equal(recorder.selectCalls.length, 1);
    assert.equal(recorder.postBodies.length, 1);
    assert.deepEqual(state, FULL_USER_RESPONSE);
  });

  it("update() re-fetches with $select after PATCH", async () => {
    const { client, recorder } = buildMockClient({
      patchResponses: [undefined],
      getResponses: [FULL_USER_RESPONSE],
    });
    const resource = new UserResource(client);

    const state = await resource.update("user-1", VALID_USER_SPEC);

    assert.equal(recorder.patchBodies.length, 1);
    assert.equal(recorder.selectCalls.length, 1);
    assert.deepEqual(state, FULL_USER_RESPONSE);
  });

  it("re-throws ProviderApiError from response validation unchanged", async () => {
    // A malformed POST response (missing id) causes extractCreatedId to
    // throw ProviderApiError. That error must reach the caller with its
    // structured `issues` intact — not be re-wrapped by `toProviderApiError`,
    // which would collapse them into a single generic message.
    const { client } = buildMockClient({
      postResponses: [
        {
          /* no id */
        },
      ],
    });
    const resource = new UserResource(client);

    await assert.rejects(
      () => resource.create(VALID_USER_SPEC),
      (error: unknown) => {
        assert.ok(
          error instanceof ProviderApiError,
          "expected ProviderApiError",
        );
        assert.equal(error.provider, "microsoft-entra-id");
        assert.equal(error.operation, "create");
        assert.ok(
          error.issues.length > 0,
          "expected at least one structured issue",
        );
        return true;
      },
    );
  });

  it("desiredStateSchema parses provider state (omits kind and UPN)", () => {
    const resource = new UserResource({} as unknown as Client);
    const result = resource.desiredStateSchema.safeParse(FULL_USER_RESPONSE);
    assert.ok(result.success, "expected provider state to parse");
    // Identity fields must not appear in the convergence projection.
    const data = result.data as Record<string, unknown>;
    assert.equal("kind" in data, false);
    assert.equal("userPrincipalName" in data, false);
  });

  it("desiredStateSchema parses the resolved spec (symmetric with state)", () => {
    const resource = new UserResource({} as unknown as Client);
    const spec = userSpecSchema.parse(VALID_USER_SPEC);
    const result = resource.desiredStateSchema.safeParse(spec);
    assert.ok(result.success);
  });
});

// ─── DomainFederationConfigurationResource adapter behaviour ─────────────────

describe("DomainFederationConfigurationResource (finding #1, #3, #7, #10)", () => {
  it("read() follows up collection list with individual GET for full state", async () => {
    const { client, recorder } = buildMockClient({
      getResponses: [{ value: [{ id: "fed-1" }] }, FULL_FEDERATION_RESPONSE],
    });
    const resource = new DomainFederationConfigurationResource(client);

    const state = await resource.read(VALID_FEDERATION_SPEC);

    assert.equal(recorder.apiCalls.length, 2);
    assert.equal(
      recorder.apiCalls[0],
      "/domains/example.com/federationConfiguration",
    );
    assert.equal(
      recorder.apiCalls[1],
      "/domains/example.com/federationConfiguration/fed-1",
    );
    // Returned state includes both the SAML attributes and the attached domain.
    assert.deepEqual(state, {
      ...FULL_FEDERATION_RESPONSE,
      domain: "example.com",
    });
  });

  it("read() returns undefined when collection is empty", async () => {
    const { client, recorder } = buildMockClient({
      getResponses: [{ value: [] }],
    });
    const resource = new DomainFederationConfigurationResource(client);

    const state = await resource.read(VALID_FEDERATION_SPEC);

    assert.equal(state, undefined);
    // No follow-up individual GET when there is nothing to fetch.
    assert.equal(recorder.apiCalls.length, 1);
  });

  it("create() follows up POST with individual GET for full state", async () => {
    const { client, recorder } = buildMockClient({
      postResponses: [{ id: "fed-1" }],
      getResponses: [FULL_FEDERATION_RESPONSE],
    });
    const resource = new DomainFederationConfigurationResource(client);

    const state = await resource.create(VALID_FEDERATION_SPEC);

    assert.equal(recorder.apiCalls.length, 2);
    assert.equal(
      recorder.apiCalls[0],
      "/domains/example.com/federationConfiguration",
    );
    assert.equal(
      recorder.apiCalls[1],
      "/domains/example.com/federationConfiguration/fed-1",
    );
    assert.deepEqual(state, {
      ...FULL_FEDERATION_RESPONSE,
      domain: "example.com",
    });
  });

  it("re-throws ProviderApiError from response validation unchanged", async () => {
    // Malformed collection response (entries missing id) triggers a Zod
    // validation failure inside `read()`. The structured issues must propagate
    // to the caller untouched.
    const { client } = buildMockClient({
      getResponses: [
        {
          value: [
            {
              /* no id */
            },
          ],
        },
      ],
    });
    const resource = new DomainFederationConfigurationResource(client);

    await assert.rejects(
      () => resource.read(VALID_FEDERATION_SPEC),
      (error: unknown) => {
        assert.ok(error instanceof ProviderApiError);
        assert.equal(error.operation, "read");
        assert.ok(error.issues.length > 0);
        return true;
      },
    );
  });

  it("desiredStateSchema parses provider state (omits kind and domain)", () => {
    const resource = new DomainFederationConfigurationResource(
      {} as unknown as Client,
    );
    const result = resource.desiredStateSchema.safeParse({
      ...FULL_FEDERATION_RESPONSE,
      domain: "example.com",
    });
    assert.ok(result.success);
    const data = result.data as Record<string, unknown>;
    assert.equal("kind" in data, false);
    assert.equal("domain" in data, false);
  });

  it("desiredStateSchema parses the resolved spec (symmetric with state)", () => {
    const resource = new DomainFederationConfigurationResource(
      {} as unknown as Client,
    );
    const spec = domainFederationConfigurationSpecSchema.parse(
      VALID_FEDERATION_SPEC,
    );
    const result = resource.desiredStateSchema.safeParse(spec);
    if (!result.success) {
      throw new Error(
        `parse failed: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    assert.ok(result.success);
  });
});
