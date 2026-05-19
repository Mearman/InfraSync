import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ResolvedScopes } from "@infrasync/core/provider";
import {
  microsoftEntraIdConfigSchema,
  MicrosoftEntraIdProvider,
  userSpecSchema,
  domainFederationConfigurationSpecSchema,
  createMicrosoftEntraIdHandle,
} from "@infrasync/microsoft-entra-id/index";

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
    });
    assert.equal(federationHandle.kind, "DomainFederationConfiguration");
    assert.equal(federationHandle.ref.domain.path, "domain");

    assert.deepEqual(registered, [
      { kind: "User", name: "alice" },
      { kind: "DomainFederationConfiguration", name: "idp" },
    ]);
  });
});
