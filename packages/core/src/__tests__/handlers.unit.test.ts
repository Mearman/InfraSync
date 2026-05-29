/**
 * Unit tests for post-apply handlers.
 *
 * Tests trigger matching, execution order, failure isolation,
 * and the constraint that handlers run only in apply mode.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { InfraHandler, TriggeredOutcome } from "../handlers.js";
import { executeHandlers } from "../handlers.js";
import type { FieldDiff } from "../resource.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Non-null assertion for array index access under noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Index ${String(index)} out of bounds`);
  }
  return value;
}

interface OutcomeInput {
  readonly name: string;
  readonly action: "create" | "update" | "delete" | "no-op" | "read";
  readonly diff?: readonly FieldDiff[];
}

function makeOutcomes(inputs: readonly OutcomeInput[]): {
  readonly name: string;
  readonly action: "create" | "update" | "delete" | "no-op" | "read";
  readonly diff: readonly FieldDiff[];
}[] {
  return inputs.map((i) => ({
    name: i.name,
    action: i.action,
    diff: i.diff ?? [],
  }));
}

/** Record which outcomes a handler received. */
function trackingHandler(
  name: string,
  triggers: readonly string[],
  on?: readonly ("create" | "update" | "delete")[],
): {
  handler: InfraHandler;
  calls: TriggeredOutcome[][];
} {
  const calls: TriggeredOutcome[][] = [];
  const handler: InfraHandler = {
    name,
    triggers,
    ...(on !== undefined ? { on } : {}),
    run: async (outcomes) => {
      calls.push([...outcomes]);
    },
  };
  return { handler, calls };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Handlers", () => {
  it("triggers on resource create", async () => {
    const tracker = trackingHandler("on-create", ["bucket"]);
    const outcomes = makeOutcomes([{ name: "bucket", action: "create" }]);

    const result = await executeHandlers([tracker.handler], outcomes);

    assert.equal(result.length, 1);
    assert.equal(at(result, 0).status, "success");
    assert.equal(at(result, 0).handler, "on-create");
    assert.deepEqual(at(result, 0).triggeredResources, ["bucket"]);
    assert.equal(tracker.calls.length, 1);
    assert.equal(at(tracker.calls, 0).length, 1);
    assert.equal(at(at(tracker.calls, 0), 0).resource, "bucket");
    assert.equal(at(at(tracker.calls, 0), 0).action, "create");
  });

  it("triggers on resource update", async () => {
    const tracker = trackingHandler("on-update", ["record"]);
    const diff: readonly FieldDiff[] = [
      { path: "ttl", desired: 300, actual: 600 },
    ];
    const outcomes = makeOutcomes([{ name: "record", action: "update", diff }]);

    const result = await executeHandlers([tracker.handler], outcomes);

    assert.equal(result.length, 1);
    assert.equal(at(result, 0).status, "success");
    assert.equal(tracker.calls.length, 1);
    const received = at(at(tracker.calls, 0), 0);
    assert.equal(received.action, "update");
    assert.equal(received.diff.length, 1);
    assert.equal(at(received.diff, 0).path, "ttl");
  });

  it("triggers on resource delete", async () => {
    const tracker = trackingHandler("on-delete", ["old-bucket"]);
    const outcomes = makeOutcomes([{ name: "old-bucket", action: "delete" }]);

    const result = await executeHandlers([tracker.handler], outcomes);

    assert.equal(result.length, 1);
    assert.equal(at(result, 0).status, "success");
    assert.equal(at(at(tracker.calls, 0), 0).action, "delete");
  });

  it("does NOT trigger on no-op (unchanged resource)", async () => {
    const tracker = trackingHandler("noop-test", ["bucket"]);
    const outcomes = makeOutcomes([{ name: "bucket", action: "no-op" }]);

    const result = await executeHandlers([tracker.handler], outcomes);

    assert.equal(result.length, 0);
    assert.equal(tracker.calls.length, 0);
  });

  it("does NOT trigger on read action", async () => {
    const tracker = trackingHandler("read-test", ["bucket"]);
    const outcomes = makeOutcomes([{ name: "bucket", action: "read" }]);

    const result = await executeHandlers([tracker.handler], outcomes);

    assert.equal(result.length, 0);
    assert.equal(tracker.calls.length, 0);
  });

  it("runs at most once even when multiple triggering resources changed", async () => {
    const tracker = trackingHandler("multi", ["a", "b", "c"]);
    const outcomes = makeOutcomes([
      { name: "a", action: "create" },
      { name: "b", action: "create" },
      { name: "c", action: "delete" },
    ]);

    const result = await executeHandlers([tracker.handler], outcomes);

    assert.equal(result.length, 1);
    assert.equal(at(result, 0).status, "success");
    // Handler ran exactly once
    assert.equal(tracker.calls.length, 1);
    // Received all three triggered outcomes
    assert.equal(at(tracker.calls, 0).length, 3);
    assert.deepEqual(at(result, 0).triggeredResources, ["a", "b", "c"]);
  });

  it("runs multiple handlers in declaration order", async () => {
    const order: string[] = [];
    const h1: InfraHandler = {
      name: "first",
      triggers: ["x"],
      run: async () => {
        order.push("first");
      },
    };
    const h2: InfraHandler = {
      name: "second",
      triggers: ["x"],
      run: async () => {
        order.push("second");
      },
    };
    const h3: InfraHandler = {
      name: "third",
      triggers: ["x"],
      run: async () => {
        order.push("third");
      },
    };

    const outcomes = makeOutcomes([{ name: "x", action: "create" }]);
    const result = await executeHandlers([h1, h2, h3], outcomes);

    assert.equal(result.length, 3);
    assert.deepEqual(order, ["first", "second", "third"]);
  });

  it("reports handler failure without affecting other handlers", async () => {
    const order: string[] = [];
    const h1: InfraHandler = {
      name: "good-before",
      triggers: ["x"],
      run: async () => {
        order.push("before");
      },
    };
    const h2: InfraHandler = {
      name: "failing",
      triggers: ["x"],
      run: async () => {
        throw new Error("handler exploded");
      },
    };
    const h3: InfraHandler = {
      name: "good-after",
      triggers: ["x"],
      run: async () => {
        order.push("after");
      },
    };

    const outcomes = makeOutcomes([{ name: "x", action: "create" }]);
    const result = await executeHandlers([h1, h2, h3], outcomes);

    assert.equal(result.length, 3);
    assert.equal(at(result, 0).status, "success");
    assert.equal(at(result, 1).status, "failed");
    assert.equal(at(result, 1).error, "handler exploded");
    assert.equal(at(result, 2).status, "success");
    // Both non-failing handlers ran
    assert.deepEqual(order, ["before", "after"]);
  });

  it("receives correct TriggeredOutcome with action and diff", async () => {
    const diff: readonly FieldDiff[] = [
      { path: "name", desired: "new-name", actual: "old-name" },
      { path: "region", desired: "us-east-1", actual: "eu-west-1" },
    ];
    const tracker = trackingHandler("verify-diff", ["r"]);
    const outcomes = makeOutcomes([{ name: "r", action: "update", diff }]);

    await executeHandlers([tracker.handler], outcomes);

    assert.equal(tracker.calls.length, 1);
    const received = at(at(tracker.calls, 0), 0);
    assert.equal(received.resource, "r");
    assert.equal(received.action, "update");
    assert.equal(received.diff.length, 2);
    assert.equal(at(received.diff, 0).path, "name");
    assert.equal(at(received.diff, 0).desired, "new-name");
    assert.equal(at(received.diff, 0).actual, "old-name");
  });

  it("supports wildcard triggers matching all resources", async () => {
    const tracker = trackingHandler("wildcard", ["*"]);
    const outcomes = makeOutcomes([
      { name: "a", action: "create" },
      { name: "b", action: "update" },
      { name: "c", action: "delete" },
      { name: "d", action: "no-op" }, // excluded from changed outcomes
    ]);

    const result = await executeHandlers([tracker.handler], outcomes);

    assert.equal(result.length, 1);
    assert.deepEqual(at(result, 0).triggeredResources, ["a", "b", "c"]);
    // no-op excluded
    assert.equal(at(tracker.calls, 0).length, 3);
  });

  it("filters by action type in `on`", async () => {
    const tracker = trackingHandler("create-only", ["x", "y"], ["create"]);
    const outcomes = makeOutcomes([
      { name: "x", action: "create" },
      { name: "y", action: "update" },
    ]);

    const result = await executeHandlers([tracker.handler], outcomes);

    assert.equal(result.length, 1);
    // Only x matched (create), y was update
    assert.deepEqual(at(result, 0).triggeredResources, ["x"]);
  });

  it("triggers on all actions when `on` is omitted", async () => {
    const tracker = trackingHandler("all-actions", ["x"]);
    const outcomes = makeOutcomes([{ name: "x", action: "create" }]);

    const result = await executeHandlers([tracker.handler], outcomes);
    assert.equal(result.length, 1);
  });

  it("does not trigger when no resources match", async () => {
    const tracker = trackingHandler("no-match", ["nonexistent"]);
    const outcomes = makeOutcomes([{ name: "other", action: "create" }]);

    const result = await executeHandlers([tracker.handler], outcomes);
    assert.equal(result.length, 0);
    assert.equal(tracker.calls.length, 0);
  });

  it("returns empty array when no handlers registered", async () => {
    const outcomes = makeOutcomes([{ name: "x", action: "create" }]);
    const result = await executeHandlers([], outcomes);
    assert.equal(result.length, 0);
  });

  it("returns empty array when no outcomes changed", async () => {
    const tracker = trackingHandler("no-changes", ["x"]);
    const outcomes = makeOutcomes([{ name: "x", action: "no-op" }]);

    const result = await executeHandlers([tracker.handler], outcomes);
    assert.equal(result.length, 0);
  });

  it("reports non-Error thrown values as strings", async () => {
    const h: InfraHandler = {
      name: "string-throw",
      triggers: ["x"],
      run: async () => {
        throw new Error("something went wrong");
      },
    };

    const outcomes = makeOutcomes([{ name: "x", action: "create" }]);
    const result = await executeHandlers([h], outcomes);

    assert.equal(result.length, 1);
    assert.equal(at(result, 0).status, "failed");
    assert.equal(at(result, 0).error, "something went wrong");
  });

  it("handler with multiple triggers matching a single resource triggers once", async () => {
    const tracker = trackingHandler("multi-trigger", ["a", "b"]);
    const outcomes = makeOutcomes([{ name: "a", action: "create" }]);

    const result = await executeHandlers([tracker.handler], outcomes);

    assert.equal(result.length, 1);
    assert.deepEqual(at(result, 0).triggeredResources, ["a"]);
    assert.equal(tracker.calls.length, 1);
  });

  it("does not trigger when `on` list has no matching actions", async () => {
    const tracker = trackingHandler("delete-only", ["x"], ["delete"]);
    const outcomes = makeOutcomes([{ name: "x", action: "create" }]);

    const result = await executeHandlers([tracker.handler], outcomes);
    assert.equal(result.length, 0);
  });
});
