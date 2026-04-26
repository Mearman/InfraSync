import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tailscaleConfigSchema,
  TailscaleProvider,
} from "@infrasync/tailscale/index";
import { aclPolicySpecSchema } from "@infrasync/tailscale/acl-policy";
import { tailnetKeySpecSchema } from "@infrasync/tailscale/tailnet-key";
import { dnsNameserversSpecSchema } from "@infrasync/tailscale/dns-nameservers";
import { dnsSearchPathsSpecSchema } from "@infrasync/tailscale/dns-search-paths";
import { dnsPreferencesSpecSchema } from "@infrasync/tailscale/dns-preferences";
import { ResolvedScopes } from "@infrasync/core/provider";

describe("Tailscale adapter", () => {
  it("validates config schema", () => {
    const valid = { apiKey: "tskey-api-test", tailnetId: "tailnet-1" };
    const result = tailscaleConfigSchema.safeParse(valid);
    assert.ok(result.success);

    const withBaseUrl = {
      apiKey: "tskey-api-test",
      tailnetId: "tailnet-1",
      baseUrl: "https://api.us.tailscale.com",
    };
    const result2 = tailscaleConfigSchema.safeParse(withBaseUrl);
    assert.ok(result2.success);
  });

  it("rejects invalid config", () => {
    const missing = { apiKey: "tskey-api-test" };
    const result = tailscaleConfigSchema.safeParse(missing);
    assert.ok(!result.success);
  });

  it("provider lists all supported kinds", () => {
    const provider = new TailscaleProvider();
    const kinds = provider.supportedKinds();
    assert.deepEqual(kinds, [
      "ACLPolicy",
      "TailnetKey",
      "DNSNameservers",
      "DNSSearchPaths",
      "DNSPreferences",
    ]);
  });

  it("provider creates handlers for all kinds", () => {
    const provider = new TailscaleProvider();
    const scopes = ResolvedScopes.empty;
    for (const kind of provider.supportedKinds()) {
      const handler = provider.resourceHandler(kind, scopes);
      assert.ok(handler !== undefined, `Handler for ${kind} should exist`);
      assert.equal(handler.kind, kind);
    }
  });

  it("provider throws for unknown kind", () => {
    const provider = new TailscaleProvider();
    assert.throws(
      () => provider.resourceHandler("Unknown", ResolvedScopes.empty),
      /unsupported resource kind/,
    );
  });

  // ─── Schema validation tests ─────────────────────────────────────────────

  it("parses valid ACL policy spec", () => {
    const spec = {
      kind: "ACLPolicy",
      acls: [{ action: "accept" as const, src: ["group:admin"], dst: ["*:*"] }],
      groups: { "group:admin": ["user@example.com"] },
      ssh: [
        {
          action: "check" as const,
          src: ["group:admin"],
          dst: ["tag:ssh"],
          users: ["root"],
        },
      ],
    };
    const result = aclPolicySpecSchema.safeParse(spec);
    assert.ok(result.success);
    assert.equal(result.data.acls.length, 1);
    assert.ok(result.data.groups !== undefined);
    assert.ok(result.data.ssh !== undefined);
  });

  it("parses minimal ACL policy spec", () => {
    const spec = {
      kind: "ACLPolicy",
      acls: [{ action: "accept" as const, src: ["*"], dst: ["*:*"] }],
    };
    const result = aclPolicySpecSchema.safeParse(spec);
    assert.ok(result.success);
    assert.equal(result.data.groups, undefined);
  });

  it("rejects invalid ACL action", () => {
    const spec = {
      kind: "ACLPolicy",
      acls: [{ action: "invalid", src: ["*"], dst: ["*:*"] }],
    };
    const result = aclPolicySpecSchema.safeParse(spec);
    assert.ok(!result.success);
  });

  it("parses valid TailnetKey spec", () => {
    const spec = {
      kind: "TailnetKey",
      description: "CI runner key",
      reusable: true,
      ephemeral: true,
      tags: ["tag:ci"],
      expirySeconds: 3600,
    };
    const result = tailnetKeySpecSchema.safeParse(spec);
    assert.ok(result.success);
    assert.equal(result.data.description, "CI runner key");
    assert.equal(result.data.reusable, true);
  });

  it("parses minimal TailnetKey spec", () => {
    const spec = {
      kind: "TailnetKey",
      description: "Minimal key",
      reusable: false,
      ephemeral: false,
    };
    const result = tailnetKeySpecSchema.safeParse(spec);
    assert.ok(result.success);
    assert.equal(result.data.tags, undefined);
  });

  it("rejects TailnetKey without description", () => {
    const spec = {
      kind: "TailnetKey",
      reusable: false,
      ephemeral: false,
    };
    const result = tailnetKeySpecSchema.safeParse(spec);
    assert.ok(!result.success);
  });

  it("parses valid DNS nameservers spec", () => {
    const spec = {
      kind: "DNSNameservers",
      nameservers: ["1.1.1.1", "8.8.8.8"],
    };
    const result = dnsNameserversSpecSchema.safeParse(spec);
    assert.ok(result.success);
    assert.equal(result.data.nameservers.length, 2);
  });

  it("rejects empty nameservers list", () => {
    const spec = { kind: "DNSNameservers", nameservers: [] };
    const result = dnsNameserversSpecSchema.safeParse(spec);
    assert.ok(!result.success);
  });

  it("parses valid DNS search paths spec", () => {
    const spec = {
      kind: "DNSSearchPaths",
      searchPaths: ["example.com", "internal.example.com"],
    };
    const result = dnsSearchPathsSpecSchema.safeParse(spec);
    assert.ok(result.success);
  });

  it("parses valid DNS preferences spec", () => {
    const spec = { kind: "DNSPreferences", magicDNS: true };
    const result = dnsPreferencesSpecSchema.safeParse(spec);
    assert.ok(result.success);
    assert.equal(result.data.magicDNS, true);
  });

  it("rejects DNS preferences without magicDNS", () => {
    const spec = { kind: "DNSPreferences" };
    const result = dnsPreferencesSpecSchema.safeParse(spec);
    assert.ok(!result.success);
  });
});
