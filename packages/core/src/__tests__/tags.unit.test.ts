/**
 * Unit tests for resource tag filtering in the plan phase.
 *
 * Tests that tags, skipTags, and their combination correctly filter
 * resources, include transitive dependencies, and demote dependency-only
 * resources to read actions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import type {
  ProviderPort,
  ResourcePort,
  ResolvedScopes,
} from "../provider.js";
import { planPhase } from "../plan-phase.js";
import type { InfraIR, ResourceIR } from "../types.js";
import { StateMap } from "../state-map.js";

// ─── Mock provider ───────────────────────────────────────────────────────────

const specSchema = z.strictObject({
  kind: z.string().trim().min(1),
  name: z.string().trim().min(1),
  value: z.string().trim().optional(),
});

const stateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    value: z.string().trim().optional(),
    status: z.string().trim(),
  })
  .readonly();

const identitySchema = z.strictObject({
  kind: z.string().trim().min(1),
  name: z.string().trim().min(1),
});

const desiredStateSchema = z.object({
  value: specSchema.shape.value,
});

class TagTestResource implements ResourcePort {
  readonly kind = "TagTestResource";
  readonly specSchema = specSchema;
  readonly stateSchema = stateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      if (typeof (state as { id: unknown }).id === "string") {
        return (state as { id: string }).id;
      }
    }
    throw new Error("Invalid state");
  }

  async read(_spec: unknown): Promise<undefined> {
    return undefined;
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = specSchema.safeParse(spec);
    const name = parsed.success ? parsed.data.name : "unknown";
    const value = parsed.success ? parsed.data.value : undefined;
    const result: Record<string, unknown> = {
      id: `mock-${name}`,
      name,
      status: "active",
    };
    if (value !== undefined) result.value = value;
    return result;
  }

  async update(_id: string, spec: unknown): Promise<unknown> {
    return this.create(spec);
  }
}

class TagTestProvider implements ProviderPort {
  readonly name = "tag-test";
  readonly configSchema = z.strictObject({});

  async connect(): Promise<void> {
    /* no-op */
  }
  async disconnect(): Promise<void> {
    /* no-op */
  }

  supportedKinds(): string[] {
    return ["TagTestResource"];
  }

  resourceHandler(kind: string, _scopes: ResolvedScopes): ResourcePort {
    if (kind === "TagTestResource") return new TagTestResource();
    throw new Error(`Unknown kind: ${kind}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Non-null assertion for array index access under noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Index ${String(index)} out of bounds`);
  }
  return value;
}

function makeResource(
  name: string,
  deps: readonly string[] = [],
  tags?: readonly string[],
): ResourceIR {
  const refBindings = deps.map((dep) => ({
    specPath: "value",
    targetResource: dep,
    statePath: "id",
  }));
  return {
    name,
    provider: "prov",
    kind: "TagTestResource",
    mode: "manage",
    spec: { kind: "TagTestResource", name },
    ...(deps.length > 0
      ? {
          dependsOn: Object.freeze([...deps]),
          refBindings: Object.freeze(refBindings),
        }
      : {}),
    ...(tags !== undefined && tags.length > 0
      ? { tags: Object.freeze([...tags]) }
      : {}),
  };
}

function makeIR(resources: readonly ResourceIR[]): InfraIR {
  return {
    name: "tag-test",
    providers: [{ key: "prov", adapterName: "tag-test", config: {} }],
    resources: Object.freeze([...resources]),
  };
}

function setupPlanPhase(
  resources: readonly ResourceIR[],
  tags?: readonly string[],
  skipTags?: readonly string[],
): ReturnType<typeof planPhase> {
  const provider = new TagTestProvider();
  const instances = new Map<string, ProviderPort>();
  instances.set("prov", provider);
  const configs = new Map<string, Record<string, unknown>>();
  configs.set("prov", {});
  const stateMap = new StateMap();

  return planPhase({
    ir: makeIR(resources),
    stateMap,
    instances,
    configs,
    ...(tags !== undefined ? { tags } : {}),
    ...(skipTags !== undefined ? { skipTags } : {}),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Tag filtering", () => {
  it("includes all resources when no tags are specified", () => {
    const resources = [
      makeResource("a", [], ["dns"]),
      makeResource("b", [], ["public"]),
      makeResource("c"),
    ];

    const result = setupPlanPhase(resources);
    assert.equal(result.actionDag.actions.length, 3);
    assert.equal(result.issues.length, 0);
  });

  it("includes only tagged resources and their dependencies", () => {
    // a (untagged) ← b (tagged "dns") ← c (untagged)
    const resources = [
      makeResource("a"), // untagged, dependency of b
      makeResource("b", ["a"], ["dns"]), // tagged "dns"
      makeResource("c", ["b"]), // untagged, depends on b (not included)
      makeResource("d"), // untagged, independent
    ];

    const result = setupPlanPhase(resources, ["dns"]);
    const actionNames = result.actionDag.actions.map((a) => a.resource);

    // a is included as a transitive dependency of b
    assert.ok(
      actionNames.includes("a"),
      "a should be included as dependency of b",
    );
    // b is directly tagged
    assert.ok(actionNames.includes("b"), "b should be included (tagged)");
    // c depends on b but is not tagged — should NOT be included
    assert.ok(
      !actionNames.includes("c"),
      "c should be excluded (untagged, not a dependency)",
    );
    // d is independent and untagged
    assert.ok(
      !actionNames.includes("d"),
      "d should be excluded (independent, untagged)",
    );
  });

  it("forces untagged dependencies to read-only actions", () => {
    // a (untagged) ← b (tagged "dns")
    const resources = [
      makeResource("a"), // untagged dependency
      makeResource("b", ["a"], ["dns"]), // tagged
    ];

    const result = setupPlanPhase(resources, ["dns"]);
    assert.equal(result.actionDag.actions.length, 2);

    // a should be a read or no-op (no state → no-op)
    const actionA = result.actionDag.actions.find((a) => a.resource === "a");
    assert.ok(actionA !== undefined, "a should have an action");
    assert.ok(
      actionA.action === "read" || actionA.action === "no-op",
      `a should be read or no-op, got ${actionA.action}`,
    );

    // b should be a create action (tagged, no state)
    const actionB = result.actionDag.actions.find((a) => a.resource === "b");
    assert.ok(actionB !== undefined, "b should have an action");
    assert.equal(actionB.action, "create");
  });

  it("includes deep transitive dependencies", () => {
    // a ← b ← c (tagged "dns")
    const resources = [
      makeResource("a"),
      makeResource("b", ["a"]),
      makeResource("c", ["b"], ["dns"]),
    ];

    const result = setupPlanPhase(resources, ["dns"]);
    const actionNames = result.actionDag.actions.map((a) => a.resource);

    assert.ok(
      actionNames.includes("a"),
      "a should be included (transitive dep of c)",
    );
    assert.ok(
      actionNames.includes("b"),
      "b should be included (direct dep of c)",
    );
    assert.ok(actionNames.includes("c"), "c should be included (tagged)");
  });

  it("excludes resources with skipTags unless depended on", () => {
    // a (skip: "expensive") ← b (tagged "dns")
    // c (skip: "expensive", independent)
    const resources = [
      makeResource("a", [], ["expensive"]),
      makeResource("b", ["a"], ["dns"]),
      makeResource("c", [], ["expensive"]),
    ];

    const result = setupPlanPhase(resources, undefined, ["expensive"]);
    const actionNames = result.actionDag.actions.map((a) => a.resource);

    // a is skipped but is a dependency of b — should be included
    assert.ok(
      actionNames.includes("a"),
      "a should be included (depended on by b)",
    );
    // b is not skipped
    assert.ok(actionNames.includes("b"), "b should be included (not skipped)");
    // c is skipped and not depended on
    assert.ok(
      !actionNames.includes("c"),
      "c should be excluded (skipped, not depended on)",
    );
  });

  it("combines tags and skipTags correctly", () => {
    // a (tagged "dns") ← b (tagged "expensive")  [b depends on a]
    // c (tagged "dns", tagged "expensive") — included by tag, skip overruled
    // d (tagged "expensive") — excluded by skipTags
    const resources = [
      makeResource("a", [], ["dns"]),
      makeResource("b", ["a"], ["expensive"]),
      makeResource("c", [], ["dns", "expensive"]),
      makeResource("d", [], ["expensive"]),
    ];

    const result = setupPlanPhase(resources, ["dns"], ["expensive"]);
    const actionNames = result.actionDag.actions.map((a) => a.resource);

    assert.ok(actionNames.includes("a"), "a should be included (tagged dns)");
    assert.ok(
      !actionNames.includes("b"),
      "b should be excluded (tagged expensive, not a dependency of any included resource)",
    );
    assert.ok(
      actionNames.includes("c"),
      "c should be included (tagged dns overrides skipTags)",
    );
    assert.ok(
      !actionNames.includes("d"),
      "d should be excluded (skipTags, not depended on)",
    );
  });

  it("empty tags list includes all resources", () => {
    const resources = [makeResource("a", [], ["dns"]), makeResource("b")];

    const result = setupPlanPhase(resources, []);
    assert.equal(result.actionDag.actions.length, 2);
  });

  it("empty skipTags does not exclude anything", () => {
    const resources = [makeResource("a", [], ["expensive"]), makeResource("b")];

    const result = setupPlanPhase(resources, undefined, []);
    assert.equal(result.actionDag.actions.length, 2);
  });

  it("resources with no matching tags are excluded", () => {
    const resources = [
      makeResource("a", [], ["public"]),
      makeResource("b", [], ["internal"]),
    ];

    const result = setupPlanPhase(resources, ["dns"]);
    assert.equal(result.actionDag.actions.length, 0);
  });

  it("a resource matching multiple tags is included if any match", () => {
    const resources = [makeResource("a", [], ["dns", "public"])];

    const result = setupPlanPhase(resources, ["public"]);
    assert.equal(result.actionDag.actions.length, 1);
    assert.equal(at(result.actionDag.actions, 0).resource, "a");
  });

  it("untagged resource with existing state becomes read when dependency-only", () => {
    const resources = [makeResource("a"), makeResource("b", ["a"], ["dns"])];

    // Set up state map with existing state for a
    const provider = new TagTestProvider();
    const instances = new Map<string, ProviderPort>();
    instances.set("prov", provider);
    const configs = new Map<string, Record<string, unknown>>();
    configs.set("prov", {});
    const stateMap = new StateMap();
    stateMap.setRaw("a", { id: "existing-a", name: "a", status: "active" });
    stateMap.setRaw("b", undefined);

    const result = planPhase({
      ir: makeIR(resources),
      stateMap,
      instances,
      configs,
      tags: ["dns"],
    });

    const actionA = result.actionDag.actions.find((a) => a.resource === "a");
    assert.ok(actionA !== undefined);
    assert.equal(
      actionA.action,
      "read",
      "a should be read (dependency-only with existing state)",
    );
  });
});
