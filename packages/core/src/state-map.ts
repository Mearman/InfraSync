/**
 * Typed state map — the output of the Read phase.
 *
 * Stores validated state for each resource, populated during the Read phase
 * and consumed by the Plan and Execute phases. Every entry is validated
 * through the resource's state schema at insertion time.
 *
 * Serialisable to plain JSON. Can be persisted alongside the Action DAG
 * for plan reproducibility.
 */
import type { ResourcePort } from "./provider.js";
import { collectZodIssues, type ResourceIssue } from "./resource.js";

// ─── State validation ────────────────────────────────────────────────────────

/**
 * Error thrown when state validation fails at insertion time.
 */
export class StateValidationError extends Error {
  constructor(
    public readonly resource: string,
    public readonly issues: readonly ResourceIssue[],
  ) {
    super(
      `State validation failed for "${resource}": ${issues.map((i) => i.message).join("; ")}`,
    );
    this.name = "StateValidationError";
  }
}

// ─── StateMap ────────────────────────────────────────────────────────────────

/**
 * A typed, validated map of resource states.
 *
 * Populated during the Read phase. Each entry is validated through the
 * resource's state schema at insertion time — consumers can trust that
 * values are valid without re-validating.
 *
 * Serialisable: `toJSON()` produces plain JSON. `fromJSON()` reconstructs
 * a StateMap from serialised data (without re-validation, since the data
 * was validated at original insertion time).
 */
export class StateMap {
  private readonly entries = new Map<string, unknown>();

  /**
   * Validate raw state through the handler's stateSchema and store.
   * Throws StateValidationError if validation fails.
   */
  set(name: string, handler: ResourcePort, raw: unknown): void {
    if (raw === undefined) {
      // Resource doesn't exist — store undefined to distinguish from "not read"
      this.entries.set(name, undefined);
      return;
    }

    const result = handler.stateSchema.safeParse(raw);
    if (!result.success) {
      const issues = collectZodIssues(name, result.error);
      throw new StateValidationError(name, issues);
    }

    this.entries.set(name, result.data);
  }

  /**
   * Set a raw value without validation.
   * Used when reconstructing from serialised data that was already validated.
   */
  setRaw(name: string, value: unknown): void {
    this.entries.set(name, value);
  }

  /**
   * Retrieve validated state for a resource.
   * Returns undefined if the resource doesn't exist in the provider.
   */
  get(name: string): unknown {
    return this.entries.get(name);
  }

  /**
   * Check whether a resource has been read.
   * Returns true even if the resource doesn't exist (state is undefined).
   */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Serialise the state map to plain JSON.
   * Values are the raw validated data — plain JSON objects.
   */
  toJSON(): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [key, value] of this.entries) {
      data[key] = value;
    }
    return data;
  }

  /**
   * Reconstruct a StateMap from serialised JSON.
   * Values are not re-validated — they were validated at original insertion time.
   */
  static fromJSON(data: Record<string, unknown>): StateMap {
    const map = new StateMap();
    for (const [key, value] of Object.entries(data)) {
      map.entries.set(key, value);
    }
    return map;
  }

  /**
   * Number of resources in the state map.
   */
  get size(): number {
    return this.entries.size;
  }
}
