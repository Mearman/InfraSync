/**
 * Unit tests for scope resolution: ResolvedScopes class, resolveScopes(),
 * and ScopeError.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ResolvedScopes, ScopeError } from "../provider.js";
import { resolveScopes } from "../resource.js";
import type { ResourceScopes } from "../provider.js";

// ─── ResolvedScopes class ────────────────────────────────────────────────────

describe("ResolvedScopes", () => {
  it("returns values from the constructor entries", () => {
    const scopes = new ResolvedScopes([
      ["accountId", "acc-123"],
      ["region", "us-east-1"],
    ]);
    assert.equal(scopes.get("accountId"), "acc-123");
    assert.equal(scopes.get("region"), "us-east-1");
  });

  it("throws ScopeError for unknown scope names", () => {
    const scopes = new ResolvedScopes([["accountId", "acc-123"]]);
    assert.throws(() => scopes.get("unknown"), ScopeError);
  });

  it("empty static throws on access", () => {
    assert.throws(() => ResolvedScopes.empty.get("anything"), ScopeError);
  });

  it("empty static returns the same instance", () => {
    assert.strictEqual(ResolvedScopes.empty, ResolvedScopes.empty);
  });
});

// ─── resolveScopes() ─────────────────────────────────────────────────────────

describe("resolveScopes()", () => {
  it("returns empty scopes when declarations are undefined", () => {
    const result = resolveScopes(undefined, {}, {});
    assert.strictEqual(result, ResolvedScopes.empty);
  });

  it("resolves config scopes from provider config", () => {
    const decls: ResourceScopes = {
      accountId: { config: "accountId" },
    };
    const result = resolveScopes(decls, {}, { accountId: "acc-456" });
    assert.equal(result.get("accountId"), "acc-456");
  });

  it("resolves ref scopes from resolved spec", () => {
    const decls: ResourceScopes = {
      applicationId: { ref: "applicationId" },
    };
    const result = resolveScopes(decls, { applicationId: "app-789" }, {});
    assert.equal(result.get("applicationId"), "app-789");
  });

  it("resolves mixed config and ref scopes", () => {
    const decls: ResourceScopes = {
      accountId: { config: "accountId" },
      applicationId: { ref: "applicationId" },
    };
    const result = resolveScopes(
      decls,
      { applicationId: "app-789" },
      { accountId: "acc-456" },
    );
    assert.equal(result.get("accountId"), "acc-456");
    assert.equal(result.get("applicationId"), "app-789");
  });

  it("throws ScopeError when config field is missing", () => {
    const decls: ResourceScopes = {
      accountId: { config: "accountId" },
    };
    assert.throws(
      () => resolveScopes(decls, {}, {}),
      (err: unknown) => {
        assert.ok(err instanceof ScopeError);
        assert.equal(err.scopeName, "accountId");
        assert.match(err.message, /missing from provider config/);
        return true;
      },
    );
  });

  it("throws ScopeError when config field is not a string", () => {
    const decls: ResourceScopes = {
      accountId: { config: "accountId" },
    };
    assert.throws(
      () => resolveScopes(decls, {}, { accountId: 12345 }),
      (err: unknown) => {
        assert.ok(err instanceof ScopeError);
        assert.match(err.message, /not a string/);
        return true;
      },
    );
  });

  it("throws ScopeError when ref field is missing from spec", () => {
    const decls: ResourceScopes = {
      applicationId: { ref: "applicationId" },
    };
    assert.throws(
      () => resolveScopes(decls, {}, {}),
      (err: unknown) => {
        assert.ok(err instanceof ScopeError);
        assert.equal(err.scopeName, "applicationId");
        assert.match(err.message, /missing from spec/);
        return true;
      },
    );
  });

  it("throws ScopeError when spec is not a record", () => {
    const decls: ResourceScopes = {
      applicationId: { ref: "applicationId" },
    };
    assert.throws(
      () => resolveScopes(decls, "not-a-record", {}),
      (err: unknown) => {
        assert.ok(err instanceof ScopeError);
        assert.match(err.message, /not a record/);
        return true;
      },
    );
  });

  it("handles undefined provider config gracefully", () => {
    const decls: ResourceScopes = {
      applicationId: { ref: "applicationId" },
    };
    const result = resolveScopes(decls, { applicationId: "app-1" }, undefined);
    assert.equal(result.get("applicationId"), "app-1");
  });
});

// ─── ScopeError ──────────────────────────────────────────────────────────────

describe("ScopeError", () => {
  it("includes scope name and source in error", () => {
    const source = { config: "accountId" };
    const err = new ScopeError("accountId", source, "test message");
    assert.equal(err.name, "ScopeError");
    assert.equal(err.scopeName, "accountId");
    assert.equal(err.source, source);
    assert.match(err.message, /test message/);
  });

  it("is an instance of Error", () => {
    const err = new ScopeError("test", { config: "x" }, "msg");
    assert.ok(err instanceof Error);
  });
});
