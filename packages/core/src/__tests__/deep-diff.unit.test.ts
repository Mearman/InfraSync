import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deepDiff } from "@infrasync/core/resource";

describe("deepDiff", () => {
  it("returns empty for equal primitives", () => {
    assert.deepEqual(deepDiff(42, 42), []);
    assert.deepEqual(deepDiff("hello", "hello"), []);
    assert.deepEqual(deepDiff(true, true), []);
    assert.deepEqual(deepDiff(null, null), []);
  });

  it("returns single diff for unequal primitives", () => {
    const diffs = deepDiff(1, 2);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "$");
    assert.equal(diffs[0]?.desired, 1);
    assert.equal(diffs[0]?.actual, 2);
  });

  it("returns single diff for type mismatch", () => {
    const diffs = deepDiff("hello", 42);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "$");
  });

  it("returns diff for equal objects with different values", () => {
    const diffs = deepDiff({ a: 1, b: 2 }, { a: 1, b: 3 });
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "b");
    assert.equal(diffs[0]?.desired, 2);
    assert.equal(diffs[0]?.actual, 3);
  });

  it("returns diff for missing keys in actual", () => {
    const diffs = deepDiff({ a: 1, b: 2 }, { a: 1 });
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "b");
    assert.equal(diffs[0]?.desired, 2);
    assert.equal(diffs[0]?.actual, undefined);
  });

  it("returns diff for extra keys in actual", () => {
    const diffs = deepDiff({ a: 1 }, { a: 1, b: 2 });
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "b");
    assert.equal(diffs[0]?.desired, undefined);
    assert.equal(diffs[0]?.actual, 2);
  });

  it("recurses into nested objects", () => {
    const diffs = deepDiff({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } });
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "a.c");
    assert.equal(diffs[0]?.desired, 2);
    assert.equal(diffs[0]?.actual, 3);
  });

  it("compares arrays element-by-element", () => {
    const diffs = deepDiff([1, 2, 3], [1, 2, 4]);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "[2]");
    assert.equal(diffs[0]?.desired, 3);
    assert.equal(diffs[0]?.actual, 4);
  });

  it("shows extra elements in actual array", () => {
    const diffs = deepDiff([1, 2], [1, 2, 3]);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "[2]");
    assert.equal(diffs[0]?.desired, undefined);
    assert.equal(diffs[0]?.actual, 3);
  });

  it("shows missing elements in actual array", () => {
    const diffs = deepDiff([1, 2, 3], [1, 2]);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "[2]");
    assert.equal(diffs[0]?.desired, 3);
    assert.equal(diffs[0]?.actual, undefined);
  });

  it("uses pathPrefix for nested paths", () => {
    const diffs = deepDiff(1, 2, "root.nested");
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "root.nested");
  });

  it("returns empty for deeply equal complex objects", () => {
    const obj = { a: [1, { b: 2 }], c: "hello" };
    assert.deepEqual(deepDiff(obj, obj), []);
  });

  it("handles multiple divergent fields", () => {
    const diffs = deepDiff({ a: 1, b: 2, c: 3 }, { a: 10, b: 2, c: 30 });
    assert.equal(diffs.length, 2);
    assert.equal(diffs[0]?.path, "a");
    assert.equal(diffs[1]?.path, "c");
  });

  it("recurses into array-of-objects", () => {
    const diffs = deepDiff(
      [{ name: "a" }, { name: "b" }],
      [{ name: "a" }, { name: "c" }],
    );
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.path, "[1].name");
    assert.equal(diffs[0]?.desired, "b");
    assert.equal(diffs[0]?.actual, "c");
  });
});
