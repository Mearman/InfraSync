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
  identitySecurityDefaultsEnforcementPolicySpecSchema,
  IdentitySecurityDefaultsEnforcementPolicyResource,
  userAuthenticationMethodsSpecSchema,
  UserAuthenticationMethodsResource,
  userSoftwareOathMethodSpecSchema,
  UserSoftwareOathMethodResource,
} from "../index.js";

// ─── Mock helpers ────────────────────────────────────────────────────────────

interface GraphRequestMockOptions {
  readonly getResponses?: readonly unknown[];
  readonly postResponses?: readonly unknown[];
  readonly patchResponses?: readonly unknown[];
  readonly deleteResponses?: readonly unknown[];
}

interface GraphRequestRecorder {
  readonly apiCalls: string[];
  readonly selectCalls: (string | readonly string[])[];
  readonly getCallCount: { value: number };
  readonly postBodies: unknown[];
  readonly patchBodies: unknown[];
  readonly deleteCalls: string[];
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
  const deleteCalls: string[] = [];

  const getResponses = [...(opts.getResponses ?? [])];
  const postResponses = [...(opts.postResponses ?? [])];
  const patchResponses = [...(opts.patchResponses ?? [])];
  const deleteResponses = [...(opts.deleteResponses ?? [])];

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
    async delete(): Promise<unknown> {
      deleteCalls.push(apiCalls[apiCalls.length - 1] ?? "unknown");
      return nextResponse(deleteResponses, "DELETE");
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
    recorder: {
      apiCalls,
      selectCalls,
      getCallCount,
      postBodies,
      patchBodies,
      deleteCalls,
    },
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
  federatedIdpMfaBehavior: "acceptIfMfaDoneByFederatedIdp" as const,
  promptLoginBehavior: "disabled" as const,
  isSignedAuthenticationRequestRequired: false,
};

const VALID_SECURITY_DEFAULTS_SPEC = {
  kind: "IdentitySecurityDefaultsEnforcementPolicy" as const,
  isEnabled: false,
};

const FULL_SECURITY_DEFAULTS_RESPONSE = {
  id: "securityDefaultsPolicy",
  displayName: "Security Defaults",
  description: "Security defaults policy",
  isEnabled: true,
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
  federatedIdpMfaBehavior: "acceptIfMfaDoneByFederatedIdp",
  promptLoginBehavior: "disabled",
  isSignedAuthenticationRequestRequired: false,
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
      "FeatureRolloutPolicy",
      "IdentitySecurityDefaultsEnforcementPolicy",
      "UserAuthenticationMethods",
      "UserSoftwareOathMethod",
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
    assert.equal(result.data.promptLoginBehavior, "disabled");
    assert.equal(result.data.isSignedAuthenticationRequestRequired, false);
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

  // ─── IdentitySecurityDefaultsEnforcementPolicy spec ──────────────────────

  it("parses a valid IdentitySecurityDefaultsEnforcementPolicy spec", () => {
    const result =
      identitySecurityDefaultsEnforcementPolicySpecSchema.safeParse(
        VALID_SECURITY_DEFAULTS_SPEC,
      );
    assert.ok(result.success);
    assert.equal(result.data.isEnabled, false);
  });

  it("rejects extra fields on IdentitySecurityDefaultsEnforcementPolicy spec", () => {
    const result =
      identitySecurityDefaultsEnforcementPolicySpecSchema.safeParse({
        ...VALID_SECURITY_DEFAULTS_SPEC,
        unexpected: "field",
      });
    assert.ok(!result.success);
  });

  // ─── Typed handle ─────────────────────────────────────────────────────────

  it("typed handle registers all resource kinds", () => {
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
      promptLoginBehavior: "disabled",
      isSignedAuthenticationRequestRequired: false,
    });
    assert.equal(federationHandle.kind, "DomainFederationConfiguration");
    assert.equal(federationHandle.ref.domain.path, "domain");

    const securityDefaultsHandle =
      entra.identitySecurityDefaultsEnforcementPolicy("securityDefaults", {
        kind: "IdentitySecurityDefaultsEnforcementPolicy",
        isEnabled: false,
      });
    assert.equal(
      securityDefaultsHandle.kind,
      "IdentitySecurityDefaultsEnforcementPolicy",
    );
    assert.equal(securityDefaultsHandle.ref.isEnabled.path, "isEnabled");

    const authMethodsHandle = entra.userAuthenticationMethods("alice-auth", {
      kind: "UserAuthenticationMethods",
      userPrincipalName: "alice@example.com",
      methodTypes: ["password"],
    });
    assert.equal(authMethodsHandle.kind, "UserAuthenticationMethods");
    assert.equal(authMethodsHandle.ref.methodTypes.path, "methodTypes");

    const oathHandle = entra.userSoftwareOathMethod("admin-totp", {
      kind: "UserSoftwareOathMethod",
      userPrincipalName: "admin@example.com",
      secret: "JBSWY3DPEHPK3PXP",
    });
    assert.equal(oathHandle.kind, "UserSoftwareOathMethod");
    assert.equal(oathHandle.ref.methodId.path, "methodId");

    assert.deepEqual(registered, [
      { kind: "User", name: "alice" },
      { kind: "DomainFederationConfiguration", name: "idp" },
      {
        kind: "IdentitySecurityDefaultsEnforcementPolicy",
        name: "securityDefaults",
      },
      { kind: "UserAuthenticationMethods", name: "alice-auth" },
      { kind: "UserSoftwareOathMethod", name: "admin-totp" },
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
        "onPremisesImmutableId",
        "usageLocation",
        "userPrincipalName",
        "userType",
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

// ─── IdentitySecurityDefaultsEnforcementPolicyResource adapter behaviour ────

describe("IdentitySecurityDefaultsEnforcementPolicyResource", () => {
  it("read() fetches the singleton security defaults policy", async () => {
    const { client, recorder } = buildMockClient({
      getResponses: [FULL_SECURITY_DEFAULTS_RESPONSE],
    });
    const resource = new IdentitySecurityDefaultsEnforcementPolicyResource(
      client,
    );

    const state = await resource.read(VALID_SECURITY_DEFAULTS_SPEC);

    assert.equal(recorder.apiCalls.length, 1);
    assert.equal(
      recorder.apiCalls[0],
      "/policies/identitySecurityDefaultsEnforcementPolicy",
    );
    assert.deepEqual(state, FULL_SECURITY_DEFAULTS_RESPONSE);
  });

  it("create() patches the singleton policy and re-reads canonical state", async () => {
    const { client, recorder } = buildMockClient({
      patchResponses: [null],
      getResponses: [{ ...FULL_SECURITY_DEFAULTS_RESPONSE, isEnabled: false }],
    });
    const resource = new IdentitySecurityDefaultsEnforcementPolicyResource(
      client,
    );

    const state = await resource.create(VALID_SECURITY_DEFAULTS_SPEC);

    assert.equal(recorder.apiCalls.length, 2);
    assert.equal(
      recorder.apiCalls[0],
      "/policies/identitySecurityDefaultsEnforcementPolicy",
    );
    assert.equal(
      recorder.apiCalls[1],
      "/policies/identitySecurityDefaultsEnforcementPolicy",
    );
    assert.deepEqual(recorder.patchBodies, [{ isEnabled: false }]);
    assert.deepEqual(state, {
      ...FULL_SECURITY_DEFAULTS_RESPONSE,
      isEnabled: false,
    });
  });

  it("update() patches the singleton policy and re-reads canonical state", async () => {
    const { client, recorder } = buildMockClient({
      patchResponses: [null],
      getResponses: [{ ...FULL_SECURITY_DEFAULTS_RESPONSE, isEnabled: false }],
    });
    const resource = new IdentitySecurityDefaultsEnforcementPolicyResource(
      client,
    );

    const state = await resource.update(
      "securityDefaultsPolicy",
      VALID_SECURITY_DEFAULTS_SPEC,
    );

    assert.equal(recorder.apiCalls.length, 2);
    assert.deepEqual(recorder.patchBodies, [{ isEnabled: false }]);
    assert.deepEqual(state, {
      ...FULL_SECURITY_DEFAULTS_RESPONSE,
      isEnabled: false,
    });
  });
});

// ─── Test fixtures for new resources ─────────────────────────────────────────

const VALID_AUTH_METHODS_SPEC = {
  kind: "UserAuthenticationMethods" as const,
  userPrincipalName: "alice@example.com",
  methodTypes: ["password" as const],
};

const FULL_AUTH_METHODS_RESPONSE_USER = { id: "user-1" };
const FULL_AUTH_METHODS_RESPONSE_METHODS = {
  value: [
    {
      "@odata.type": "#microsoft.graph.passwordAuthenticationMethod",
      id: "pw-1",
    },
  ],
};

const VALID_SOFTWARE_OATH_SPEC = {
  kind: "UserSoftwareOathMethod" as const,
  userPrincipalName: "admin@example.com",
  secret: "JBSWY3DPEHPK3PXP",
};

const SOFTWARE_OATH_USER_RESPONSE = { id: "user-2" };
const SOFTWARE_OATH_METHOD_LIST_EMPTY = { value: [] };
const SOFTWARE_OATH_METHOD_LIST_PRESENT = {
  value: [{ id: "oath-1" }],
};

// ─── UserAuthenticationMethods spec ──────────────────────────────────────────

describe("UserAuthenticationMethods spec", () => {
  it("parses a valid spec with password-only", () => {
    const result = userAuthenticationMethodsSpecSchema.safeParse({
      kind: "UserAuthenticationMethods",
      userPrincipalName: "alice@example.com",
      methodTypes: ["password"],
    });
    assert.ok(result.success);
    assert.deepEqual(result.data.methodTypes, ["password"]);
  });

  it("parses a valid spec with multiple method types", () => {
    const result = userAuthenticationMethodsSpecSchema.safeParse({
      kind: "UserAuthenticationMethods",
      userPrincipalName: "admin@example.com",
      methodTypes: ["password", "softwareOath"],
    });
    assert.ok(result.success);
  });

  it("rejects spec without password in methodTypes", async () => {
    const { client } = buildMockClient({
      getResponses: [
        FULL_AUTH_METHODS_RESPONSE_USER,
        FULL_AUTH_METHODS_RESPONSE_METHODS,
      ],
    });
    const resource = new UserAuthenticationMethodsResource(client);

    await assert.rejects(
      () =>
        resource.read({
          kind: "UserAuthenticationMethods",
          userPrincipalName: "alice@example.com",
          methodTypes: ["softwareOath"],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderApiError);
        const firstIssue = error.issues[0];
        assert.ok(firstIssue !== undefined);
        assert.ok(firstIssue.message.includes("password"));
        return true;
      },
    );
  });

  it("rejects empty methodTypes", () => {
    const result = userAuthenticationMethodsSpecSchema.safeParse({
      kind: "UserAuthenticationMethods",
      userPrincipalName: "alice@example.com",
      methodTypes: [],
    });
    assert.ok(!result.success);
  });

  it("rejects unknown method type", () => {
    const result = userAuthenticationMethodsSpecSchema.safeParse({
      kind: "UserAuthenticationMethods",
      userPrincipalName: "alice@example.com",
      methodTypes: ["password", "unknown"],
    });
    assert.ok(!result.success);
  });

  it("rejects extra fields on spec", () => {
    const result = userAuthenticationMethodsSpecSchema.safeParse({
      ...VALID_AUTH_METHODS_SPEC,
      unexpected: "field",
    });
    assert.ok(!result.success);
  });
});

// ─── UserSoftwareOathMethod spec ─────────────────────────────────────────────

describe("UserSoftwareOathMethod spec", () => {
  it("parses a valid spec", () => {
    const result = userSoftwareOathMethodSpecSchema.safeParse({
      kind: "UserSoftwareOathMethod",
      userPrincipalName: "admin@example.com",
      secret: "JBSWY3DPEHPK3PXP",
    });
    assert.ok(result.success);
    assert.equal(result.data.secret, "JBSWY3DPEHPK3PXP");
  });

  it("rejects spec without secret", () => {
    const result = userSoftwareOathMethodSpecSchema.safeParse({
      kind: "UserSoftwareOathMethod",
      userPrincipalName: "admin@example.com",
    });
    assert.ok(!result.success);
  });

  it("rejects extra fields on spec", () => {
    const result = userSoftwareOathMethodSpecSchema.safeParse({
      ...VALID_SOFTWARE_OATH_SPEC,
      unexpected: "field",
    });
    assert.ok(!result.success);
  });
});

// ─── UserAuthenticationMethodsResource adapter behaviour ──────────────────────

describe("UserAuthenticationMethodsResource", () => {
  it("read() fetches user ID and auth methods", async () => {
    const { client, recorder } = buildMockClient({
      getResponses: [
        FULL_AUTH_METHODS_RESPONSE_USER,
        FULL_AUTH_METHODS_RESPONSE_METHODS,
      ],
    });
    const resource = new UserAuthenticationMethodsResource(client);

    const state = await resource.read(VALID_AUTH_METHODS_SPEC);

    assert.equal(recorder.apiCalls.length, 2);
    assert.equal(recorder.apiCalls[0], "/users/alice%40example.com");
    assert.equal(
      recorder.apiCalls[1],
      "/users/alice%40example.com/authentication/methods",
    );
    assert.deepEqual(state, {
      id: "user-1",
      userPrincipalName: "alice@example.com",
      methodTypes: ["password"],
    });
  });

  it("read() returns undefined when user is not found", async () => {
    // Build a mock that throws a GraphError-like 404 on the first GET
    const errorClient = {
      api: () => ({
        select: () => ({
          get: async () => {
            const err = new Error("Not Found");
            Object.assign(err, { statusCode: 404 });
            throw err;
          },
        }),
      }),
    } as unknown as Client;
    const resource = new UserAuthenticationMethodsResource(errorClient);

    const state = await resource.read(VALID_AUTH_METHODS_SPEC);
    assert.equal(state, undefined);
  });

  it("create() deletes disallowed methods and re-reads", async () => {
    // State: user has password + softwareOath, but spec allows only password
    const methodsBeforeEnforce = {
      value: [
        {
          "@odata.type": "#microsoft.graph.passwordAuthenticationMethod",
          id: "pw-1",
        },
        {
          "@odata.type": "#microsoft.graph.softwareOathAuthenticationMethod",
          id: "oath-1",
        },
      ],
    };
    const methodsAfterEnforce = {
      value: [
        {
          "@odata.type": "#microsoft.graph.passwordAuthenticationMethod",
          id: "pw-1",
        },
      ],
    };

    const { client, recorder } = buildMockClient({
      // enforce: fetch user + fetch methods; then re-read: fetch user + fetch methods
      getResponses: [
        FULL_AUTH_METHODS_RESPONSE_USER,
        methodsBeforeEnforce,
        FULL_AUTH_METHODS_RESPONSE_USER,
        methodsAfterEnforce,
      ],
      deleteResponses: [null],
    });
    const resource = new UserAuthenticationMethodsResource(client);

    const state = await resource.create(VALID_AUTH_METHODS_SPEC);

    // 4 GETs: 2 during enforce + 2 during re-read
    assert.equal(recorder.getCallCount.value, 4);
    // 1 DELETE for the softwareOath method
    assert.equal(recorder.deleteCalls.length, 1);
    const deleteCall = recorder.deleteCalls[0];
    assert.ok(deleteCall !== undefined);
    assert.ok(
      deleteCall.includes("softwareOathMethods"),
      "deletes via type-specific endpoint",
    );
    assert.deepEqual(state, {
      id: "user-1",
      userPrincipalName: "alice@example.com",
      methodTypes: ["password"],
    });
  });

  it("update() deletes disallowed methods and re-reads", async () => {
    const methodsBeforeEnforce = {
      value: [
        {
          "@odata.type": "#microsoft.graph.passwordAuthenticationMethod",
          id: "pw-1",
        },
        {
          "@odata.type":
            "#microsoft.graph.microsoftAuthenticatorAuthenticationMethod",
          id: "msauth-1",
        },
      ],
    };
    const methodsAfterEnforce = {
      value: [
        {
          "@odata.type": "#microsoft.graph.passwordAuthenticationMethod",
          id: "pw-1",
        },
      ],
    };

    const { client, recorder } = buildMockClient({
      getResponses: [
        FULL_AUTH_METHODS_RESPONSE_USER,
        methodsBeforeEnforce,
        FULL_AUTH_METHODS_RESPONSE_USER,
        methodsAfterEnforce,
      ],
      deleteResponses: [null],
    });
    const resource = new UserAuthenticationMethodsResource(client);

    const state = await resource.update("user-1", VALID_AUTH_METHODS_SPEC);

    assert.equal(recorder.deleteCalls.length, 1);
    const deleteCall = recorder.deleteCalls[0];
    assert.ok(deleteCall !== undefined);
    assert.ok(deleteCall.includes("microsoftAuthenticatorMethods"));
    assert.deepEqual(state, {
      id: "user-1",
      userPrincipalName: "alice@example.com",
      methodTypes: ["password"],
    });
  });

  it("desiredStateSchema parses provider state", () => {
    const resource = new UserAuthenticationMethodsResource(
      {} as unknown as Client,
    );
    const result = resource.desiredStateSchema.safeParse({
      methodTypes: ["password", "softwareOath"],
    });
    assert.ok(result.success);
  });
});

// ─── UserSoftwareOathMethodResource adapter behaviour ────────────────────────

describe("UserSoftwareOathMethodResource", () => {
  it("read() returns state when method exists", async () => {
    const { client, recorder } = buildMockClient({
      getResponses: [
        SOFTWARE_OATH_USER_RESPONSE,
        SOFTWARE_OATH_METHOD_LIST_PRESENT,
      ],
    });
    const resource = new UserSoftwareOathMethodResource(client);

    const state = await resource.read(VALID_SOFTWARE_OATH_SPEC);

    assert.equal(recorder.apiCalls.length, 2);
    assert.equal(recorder.apiCalls[0], "/users/admin%40example.com");
    assert.equal(
      recorder.apiCalls[1],
      "/users/admin%40example.com/authentication/softwareOathMethods",
    );
    assert.deepEqual(state, {
      id: "user-2",
      userPrincipalName: "admin@example.com",
      methodType: "softwareOath",
      methodId: "oath-1",
    });
  });

  it("read() returns undefined when no method exists", async () => {
    const { client } = buildMockClient({
      getResponses: [
        SOFTWARE_OATH_USER_RESPONSE,
        SOFTWARE_OATH_METHOD_LIST_EMPTY,
      ],
    });
    const resource = new UserSoftwareOathMethodResource(client);

    const state = await resource.read(VALID_SOFTWARE_OATH_SPEC);
    assert.equal(state, undefined);
  });

  it("create() posts new method and re-reads", async () => {
    // create() POSTs then re-reads (GET user + GET methods)
    const { client, recorder } = buildMockClient({
      getResponses: [
        SOFTWARE_OATH_USER_RESPONSE,
        SOFTWARE_OATH_METHOD_LIST_PRESENT,
      ],
      postResponses: [{ id: "oath-1" }],
    });
    const resource = new UserSoftwareOathMethodResource(client);

    const state = await resource.create(VALID_SOFTWARE_OATH_SPEC);

    assert.equal(recorder.postBodies.length, 1);
    assert.deepEqual(recorder.postBodies[0], { secret: "JBSWY3DPEHPK3PXP" });
    assert.deepEqual(state, {
      id: "user-2",
      userPrincipalName: "admin@example.com",
      methodType: "softwareOath",
      methodId: "oath-1",
    });
  });

  it("update() deletes existing method and recreates with new secret", async () => {
    const methodAfterRecreate = {
      value: [{ id: "oath-new" }],
    };
    const { client, recorder } = buildMockClient({
      // fetch existing + delete + post + re-read
      getResponses: [
        SOFTWARE_OATH_USER_RESPONSE,
        SOFTWARE_OATH_METHOD_LIST_PRESENT,
        SOFTWARE_OATH_USER_RESPONSE,
        methodAfterRecreate,
      ],
      postResponses: [{ id: "oath-new" }],
      deleteResponses: [null],
    });
    const resource = new UserSoftwareOathMethodResource(client);

    const state = await resource.update("user-2", VALID_SOFTWARE_OATH_SPEC);

    assert.equal(recorder.deleteCalls.length, 1);
    assert.equal(recorder.postBodies.length, 1);
    assert.deepEqual(state, {
      id: "user-2",
      userPrincipalName: "admin@example.com",
      methodType: "softwareOath",
      methodId: "oath-new",
    });
  });

  it("desiredStateSchema includes methodType but not secret", () => {
    const resource = new UserSoftwareOathMethodResource(
      {} as unknown as Client,
    );
    const result = resource.desiredStateSchema.safeParse({
      methodType: "softwareOath",
    });
    assert.ok(result.success);
    // Secret must not appear in desired state — it is write-only
    const data = result.data as Record<string, unknown>;
    assert.equal("secret" in data, false);
  });
});
