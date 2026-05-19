import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  googleWorkspaceConfigSchema,
  GoogleWorkspaceProvider,
  samlAppSpecSchema,
  buildSamlAppRefs,
  createGoogleWorkspaceHandle,
} from "@infrasync/google-workspace/index";
import { ResolvedScopes } from "@infrasync/core/provider";
import type { ResourceHandle } from "@infrasync/core/handles";
import { RefToken } from "@infrasync/core/refs";

describe("Google Workspace adapter", () => {
  it("validates oauth-user config", () => {
    const config = {
      kind: "oauth-user" as const,
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      customerId: "C00abc123",
    };
    const result = googleWorkspaceConfigSchema.safeParse(config);
    assert.ok(result.success);
    assert.equal(result.data.kind, "oauth-user");
  });

  it("validates service-account config", () => {
    const config = {
      kind: "service-account" as const,
      serviceAccountKey: JSON.stringify({ type: "service_account" }),
      subjectEmail: "admin@example.com",
      customerId: "C00abc123",
    };
    const result = googleWorkspaceConfigSchema.safeParse(config);
    assert.ok(result.success);
    assert.equal(result.data.kind, "service-account");
  });

  it("rejects config missing discriminant", () => {
    const config = {
      clientId: "x",
      clientSecret: "y",
      refreshToken: "z",
      customerId: "C00",
    };
    const result = googleWorkspaceConfigSchema.safeParse(config);
    assert.ok(!result.success);
  });

  it("rejects service-account config with non-email subject", () => {
    const config = {
      kind: "service-account" as const,
      serviceAccountKey: "key",
      subjectEmail: "not-an-email",
      customerId: "C00",
    };
    const result = googleWorkspaceConfigSchema.safeParse(config);
    assert.ok(!result.success);
  });

  it("rejects oauth-user config with empty fields", () => {
    const config = {
      kind: "oauth-user" as const,
      clientId: "",
      clientSecret: "y",
      refreshToken: "z",
      customerId: "C00",
    };
    const result = googleWorkspaceConfigSchema.safeParse(config);
    assert.ok(!result.success);
  });

  it("provider lists supported kinds", () => {
    const provider = new GoogleWorkspaceProvider();
    assert.deepEqual(provider.supportedKinds(), ["SamlApp"]);
  });

  it("provider creates handler for each supported kind", () => {
    const provider = new GoogleWorkspaceProvider();
    for (const kind of provider.supportedKinds()) {
      const handler = provider.resourceHandler(kind, ResolvedScopes.empty);
      assert.equal(handler.kind, kind);
    }
  });

  it("provider throws for unknown kind", () => {
    const provider = new GoogleWorkspaceProvider();
    assert.throws(
      () => provider.resourceHandler("Unknown", ResolvedScopes.empty),
      /No resource registered/,
    );
  });

  it("connectedClient throws before connect", () => {
    const provider = new GoogleWorkspaceProvider();
    assert.throws(() => provider.connectedClient(), /not connected/);
  });

  // ─── SamlApp spec schema ───────────────────────────────────────────────────

  it("parses a valid SamlApp spec", () => {
    const spec = {
      kind: "SamlApp" as const,
      displayName: "Microsoft 365",
      idpConfig: {
        entityId: "https://accounts.google.com/o/saml2?idpid=C00abc123",
        singleSignOnServiceUri:
          "https://accounts.google.com/o/saml2/idp?idpid=C00abc123",
      },
      spConfig: {
        entityId: "urn:federation:MicrosoftOnline",
        assertionConsumerServiceUri:
          "https://login.microsoftonline.com/login.srf",
      },
    };
    const result = samlAppSpecSchema.safeParse(spec);
    assert.ok(result.success);
    assert.equal(result.data.displayName, "Microsoft 365");
  });

  it("parses a SamlApp spec with optional IdP fields", () => {
    const spec = {
      kind: "SamlApp" as const,
      displayName: "App",
      idpConfig: {
        entityId: "https://accounts.google.com/o/saml2?idpid=X",
        singleSignOnServiceUri:
          "https://accounts.google.com/o/saml2/idp?idpid=X",
        logoutRedirectUri: "https://example.com/logout",
        changePasswordUri: "https://example.com/password",
      },
      spConfig: {
        entityId: "urn:example:sp",
        assertionConsumerServiceUri: "https://example.com/acs",
      },
    };
    const result = samlAppSpecSchema.safeParse(spec);
    assert.ok(result.success);
    assert.equal(
      result.data.idpConfig.logoutRedirectUri,
      "https://example.com/logout",
    );
  });

  it("rejects SamlApp spec with empty displayName", () => {
    const spec = {
      kind: "SamlApp" as const,
      displayName: "",
      idpConfig: {
        entityId: "https://accounts.google.com/o/saml2?idpid=X",
        singleSignOnServiceUri:
          "https://accounts.google.com/o/saml2/idp?idpid=X",
      },
      spConfig: {
        entityId: "urn:example:sp",
        assertionConsumerServiceUri: "https://example.com/acs",
      },
    };
    const result = samlAppSpecSchema.safeParse(spec);
    assert.ok(!result.success);
  });

  it("rejects SamlApp spec with invalid idpConfig URL", () => {
    const spec = {
      kind: "SamlApp" as const,
      displayName: "App",
      idpConfig: {
        entityId: "not a url",
        singleSignOnServiceUri:
          "https://accounts.google.com/o/saml2/idp?idpid=X",
      },
      spConfig: {
        entityId: "urn:example:sp",
        assertionConsumerServiceUri: "https://example.com/acs",
      },
    };
    const result = samlAppSpecSchema.safeParse(spec);
    assert.ok(!result.success);
  });

  it("rejects SamlApp spec with unknown extra fields", () => {
    const spec = {
      kind: "SamlApp" as const,
      displayName: "App",
      idpConfig: {
        entityId: "https://accounts.google.com/o/saml2?idpid=X",
        singleSignOnServiceUri:
          "https://accounts.google.com/o/saml2/idp?idpid=X",
      },
      spConfig: {
        entityId: "urn:example:sp",
        assertionConsumerServiceUri: "https://example.com/acs",
      },
      unexpected: true,
    };
    const result = samlAppSpecSchema.safeParse(spec);
    assert.ok(!result.success);
  });

  // ─── Refs and handle ──────────────────────────────────────────────────────

  it("buildSamlAppRefs produces typed RefTokens", () => {
    const refs = buildSamlAppRefs("my-saml-app");
    assert.ok(refs.id instanceof RefToken);
    assert.ok(refs.name instanceof RefToken);
    assert.ok(refs.displayName instanceof RefToken);
    assert.equal(refs.id.resource, "my-saml-app");
    assert.equal(refs.id.path, "id");
    assert.equal(refs.name.path, "name");
    assert.equal(refs.displayName.path, "displayName");
  });

  it("typed handle registers a SamlApp resource", () => {
    const registered: { kind: string; name: string }[] = [];
    const handle = createGoogleWorkspaceHandle(
      "gw",
      "google-workspace",
      (h: ResourceHandle<unknown, unknown>) => {
        registered.push({ kind: h.kind, name: h.name });
      },
    );
    const result = handle.samlApp("m365", {
      kind: "SamlApp",
      displayName: "Microsoft 365",
      idpConfig: {
        entityId: "https://accounts.google.com/o/saml2?idpid=X",
        singleSignOnServiceUri:
          "https://accounts.google.com/o/saml2/idp?idpid=X",
      },
      spConfig: {
        entityId: "urn:federation:MicrosoftOnline",
        assertionConsumerServiceUri:
          "https://login.microsoftonline.com/login.srf",
      },
    });
    assert.deepEqual(registered, [{ kind: "SamlApp", name: "m365" }]);
    assert.equal(result.kind, "SamlApp");
    assert.equal(result.name, "m365");
    assert.ok(result.ref.id instanceof RefToken);
  });

  // ─── SamlAppResource handler behaviour ────────────────────────────────────

  it("SamlApp handler reports correct kind and identity surface", () => {
    const provider = new GoogleWorkspaceProvider();
    const handler = provider.resourceHandler("SamlApp", ResolvedScopes.empty);
    assert.equal(handler.kind, "SamlApp");
    const identityResult = handler.identitySchema.safeParse({
      kind: "SamlApp",
      displayName: "App",
    });
    assert.ok(identityResult.success);
  });

  it("SamlApp handler getStateId extracts resource name", () => {
    const provider = new GoogleWorkspaceProvider();
    const handler = provider.resourceHandler("SamlApp", ResolvedScopes.empty);
    const id = handler.getStateId({
      name: "inboundSamlSsoProfiles/01abc23",
      displayName: "App",
    });
    assert.equal(id, "inboundSamlSsoProfiles/01abc23");
  });

  it("SamlApp handler getStateId throws on missing name", () => {
    const provider = new GoogleWorkspaceProvider();
    const handler = provider.resourceHandler("SamlApp", ResolvedScopes.empty);
    assert.throws(() => handler.getStateId({ displayName: "App" }));
  });

  it("SamlApp handler operations throw before connect", async () => {
    const provider = new GoogleWorkspaceProvider();
    const handler = provider.resourceHandler("SamlApp", ResolvedScopes.empty);
    await assert.rejects(
      () =>
        handler.read({
          kind: "SamlApp",
          displayName: "App",
          idpConfig: {
            entityId: "https://accounts.google.com/o/saml2?idpid=X",
            singleSignOnServiceUri:
              "https://accounts.google.com/o/saml2/idp?idpid=X",
          },
          spConfig: {
            entityId: "urn:example:sp",
            assertionConsumerServiceUri: "https://example.com/acs",
          },
        }),
      /not connected/,
    );
  });
});
