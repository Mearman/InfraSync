/**
 * Unit tests for the GitHub provider.
 *
 * Tests cover provider construction, config validation, resource
 * registration, and schema validation. API calls are mocked.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import {
  GitHubProvider,
  github,
  githubConfigSchema,
  repositorySpecSchema,
  branchProtectionSpecSchema,
  teamSpecSchema,
  actionsSecretSpecSchema,
} from "../index.js";

// ─── Config schema ──────────────────────────────────────────────────────────

describe("githubConfigSchema", () => {
  it("accepts a valid config with token", () => {
    const result = githubConfigSchema.safeParse({
      token: "ghp_abc123",
    });
    assert.ok(result.success);
  });

  it("accepts a config with baseUrl for GHES", () => {
    const result = githubConfigSchema.safeParse({
      token: "ghp_abc123",
      baseUrl: "https://github.example.com/api/v3",
    });
    assert.ok(result.success);
  });

  it("rejects a config without token", () => {
    const result = githubConfigSchema.safeParse({});
    assert.ok(!result.success);
  });

  it("rejects an empty token", () => {
    const result = githubConfigSchema.safeParse({ token: "  " });
    assert.ok(!result.success);
  });

  it("rejects unknown fields", () => {
    const result = githubConfigSchema.safeParse({
      token: "ghp_abc123",
      extra: "field",
    });
    assert.ok(!result.success);
  });
});

// ─── Provider construction ───────────────────────────────────────────────────

describe("GitHubProvider", () => {
  it("has the correct adapter name", () => {
    assert.equal(github.adapterName, "github");
  });

  it("creates a fresh provider instance", () => {
    const provider = github.create();
    assert.equal(provider.name, "github");
    assert.ok(provider.configSchema === githubConfigSchema);
  });

  it("registers all built-in resource kinds", () => {
    const provider = github.create();
    const kinds = provider.supportedKinds();
    assert.ok(kinds.includes("Repository"));
    assert.ok(kinds.includes("BranchProtection"));
    assert.ok(kinds.includes("Team"));
    assert.ok(kinds.includes("ActionsSecret"));
  });

  it("creates independent instances with separate registries", () => {
    const a = github.create();
    const b = github.create();
    // Both support the same kinds but are independent objects
    assert.deepEqual(a.supportedKinds(), b.supportedKinds());
    assert.notEqual(a, b);
  });
});

// ─── Repository schema ───────────────────────────────────────────────────────

describe("repositorySpecSchema", () => {
  it("accepts a minimal repository spec", () => {
    const result = repositorySpecSchema.safeParse({
      kind: "Repository",
      owner: "my-org",
      name: "my-repo",
    });
    assert.ok(result.success);
  });

  it("accepts a full repository spec", () => {
    const result = repositorySpecSchema.safeParse({
      kind: "Repository",
      owner: "my-org",
      name: "my-repo",
      description: "A test repo",
      private: true,
      hasIssues: true,
      hasProjects: false,
      hasWiki: false,
      allowSquashMerge: true,
      allowMergeCommit: false,
      allowRebaseMerge: true,
      allowAutoMerge: false,
      deleteBranchOnMerge: true,
      defaultBranch: "main",
      homepage: "https://example.com",
      isTemplate: false,
      topics: ["typescript", "testing"],
      visibility: "private",
    });
    assert.ok(result.success);
  });

  it("rejects a spec without owner", () => {
    const result = repositorySpecSchema.safeParse({
      kind: "Repository",
      name: "my-repo",
    });
    assert.ok(!result.success);
  });

  it("rejects a spec without name", () => {
    const result = repositorySpecSchema.safeParse({
      kind: "Repository",
      owner: "my-org",
    });
    assert.ok(!result.success);
  });

  it("rejects an invalid visibility value", () => {
    const result = repositorySpecSchema.safeParse({
      kind: "Repository",
      owner: "my-org",
      name: "my-repo",
      visibility: "super-secret",
    });
    assert.ok(!result.success);
  });
});

// ─── Branch protection schema ───────────────────────────────────────────────

describe("branchProtectionSpecSchema", () => {
  it("accepts a minimal branch protection spec", () => {
    const result = branchProtectionSpecSchema.safeParse({
      kind: "BranchProtection",
      owner: "my-org",
      repo: "my-repo",
      branch: "main",
    });
    assert.ok(result.success);
  });

  it("accepts a full branch protection spec", () => {
    const result = branchProtectionSpecSchema.safeParse({
      kind: "BranchProtection",
      owner: "my-org",
      repo: "my-repo",
      branch: "main",
      enforceAdmins: true,
      requiredStatusChecks: {
        strict: true,
        contexts: ["ci/test", "ci/lint"],
      },
      requiredPullRequestReviews: {
        requiredApprovingReviewCount: 2,
        dismissStaleReviews: true,
        requireCodeOwnerReviews: true,
      },
      requiredSignatures: true,
      restrictions: {
        teams: ["core-team"],
        users: ["admin"],
        apps: ["ci-app"],
      },
      allowForcePushes: false,
      allowDeletions: false,
      requiredLinearHistory: true,
    });
    assert.ok(result.success);
  });

  it("rejects a spec without branch", () => {
    const result = branchProtectionSpecSchema.safeParse({
      kind: "BranchProtection",
      owner: "my-org",
      repo: "my-repo",
    });
    assert.ok(!result.success);
  });

  it("rejects an invalid privacy value in requiredPullRequestReviews", () => {
    const result = branchProtectionSpecSchema.safeParse({
      kind: "BranchProtection",
      owner: "my-org",
      repo: "my-repo",
      branch: "main",
      requiredPullRequestReviews: {
        requiredApprovingReviewCount: 10,
      },
    });
    assert.ok(!result.success);
  });
});

// ─── Team schema ─────────────────────────────────────────────────────────────

describe("teamSpecSchema", () => {
  it("accepts a minimal team spec", () => {
    const result = teamSpecSchema.safeParse({
      kind: "Team",
      org: "my-org",
      name: "engineering",
    });
    assert.ok(result.success);
  });

  it("accepts a full team spec", () => {
    const result = teamSpecSchema.safeParse({
      kind: "Team",
      org: "my-org",
      name: "engineering",
      description: "Engineering team",
      privacy: "closed",
      permission: "push",
    });
    assert.ok(result.success);
  });

  it("rejects a spec without org", () => {
    const result = teamSpecSchema.safeParse({
      kind: "Team",
      name: "engineering",
    });
    assert.ok(!result.success);
  });

  it("rejects an invalid permission value", () => {
    const result = teamSpecSchema.safeParse({
      kind: "Team",
      org: "my-org",
      name: "engineering",
      permission: "sudo",
    });
    assert.ok(!result.success);
  });

  it("rejects an invalid privacy value", () => {
    const result = teamSpecSchema.safeParse({
      kind: "Team",
      org: "my-org",
      name: "engineering",
      privacy: "public",
    });
    assert.ok(!result.success);
  });
});

// ─── Actions secret schema ───────────────────────────────────────────────────

describe("actionsSecretSpecSchema", () => {
  it("accepts a valid actions secret spec", () => {
    const result = actionsSecretSpecSchema.safeParse({
      kind: "ActionsSecret",
      owner: "my-org",
      repo: "my-repo",
      secretName: "DEPLOY_KEY",
      value: "super-secret-value",
    });
    assert.ok(result.success);
  });

  it("rejects a spec without value", () => {
    const result = actionsSecretSpecSchema.safeParse({
      kind: "ActionsSecret",
      owner: "my-org",
      repo: "my-repo",
      secretName: "DEPLOY_KEY",
    });
    assert.ok(!result.success);
  });

  it("rejects an empty secret name", () => {
    const result = actionsSecretSpecSchema.safeParse({
      kind: "ActionsSecret",
      owner: "my-org",
      repo: "my-repo",
      secretName: "",
      value: "secret",
    });
    assert.ok(!result.success);
  });
});

// ─── Resource handler construction ───────────────────────────────────────────

describe("resource handler construction", () => {
  it("creates a Repository handler", () => {
    const provider = github.create();
    const handler = provider.resourceHandler(
      "Repository",
      { get: () => "unused" } as never,
    );
    assert.equal(handler.kind, "Repository");
    assert.ok(handler.specSchema === repositorySpecSchema);
  });

  it("creates a BranchProtection handler", () => {
    const provider = github.create();
    const handler = provider.resourceHandler(
      "BranchProtection",
      { get: () => "unused" } as never,
    );
    assert.equal(handler.kind, "BranchProtection");
  });

  it("creates a Team handler", () => {
    const provider = github.create();
    const handler = provider.resourceHandler(
      "Team",
      { get: () => "unused" } as never,
    );
    assert.equal(handler.kind, "Team");
  });

  it("creates an ActionsSecret handler", () => {
    const provider = github.create();
    const handler = provider.resourceHandler(
      "ActionsSecret",
      { get: () => "unused" } as never,
    );
    assert.equal(handler.kind, "ActionsSecret");
  });

  it("throws for an unknown resource kind", () => {
    const provider = github.create();
    assert.throws(() =>
      provider.resourceHandler("Unknown", { get: () => "unused" } as never),
    );
  });
});

// ─── Repository getStateId ───────────────────────────────────────────────────

describe("RepositoryResource.getStateId", () => {
  it("extracts state ID from full_name", () => {
    const provider = github.create();
    const handler = provider.resourceHandler(
      "Repository",
      { get: () => "unused" } as never,
    );
    const id = handler.getStateId({ full_name: "my-org/my-repo" });
    assert.equal(id, "my-org/my-repo");
  });

  it("falls back to owner/name extraction", () => {
    const provider = github.create();
    const handler = provider.resourceHandler(
      "Repository",
      { get: () => "unused" } as never,
    );
    const id = handler.getStateId({
      owner: { login: "my-org" },
      name: "my-repo",
    });
    assert.equal(id, "my-org/my-repo");
  });

  it("throws for invalid state", () => {
    const provider = github.create();
    const handler = provider.resourceHandler(
      "Repository",
      { get: () => "unused" } as never,
    );
    assert.throws(() => handler.getStateId({}));
  });
});

// ─── Team getStateId ─────────────────────────────────────────────────────────

describe("TeamResource.getStateId", () => {
  it("extracts state ID from id field", () => {
    const provider = github.create();
    const handler = provider.resourceHandler(
      "Team",
      { get: () => "unused" } as never,
    );
    const id = handler.getStateId({ id: 42, name: "engineering" });
    assert.equal(id, "42");
  });

  it("throws for invalid state", () => {
    const provider = github.create();
    const handler = provider.resourceHandler(
      "Team",
      { get: () => "unused" } as never,
    );
    assert.throws(() => handler.getStateId({}));
  });
});

// ─── Provider connect/disconnect ─────────────────────────────────────────────

describe("GitHubProvider connect/disconnect", () => {
  it("connects with valid config", async () => {
    const provider = github.create();
    // Should not throw — token is validated
    await provider.connect({ token: "ghp_test123" });
  });

  it("rejects invalid config on connect", async () => {
    const provider = github.create();
    await assert.rejects(() => provider.connect({}));
  });

  it("disconnects cleanly", async () => {
    const provider = github.create();
    await provider.connect({ token: "ghp_test123" });
    await provider.disconnect();
  });
});
