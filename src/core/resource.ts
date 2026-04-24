import type { RefTokenIR, SecretSourceIR } from "../ir/types.js";

// ─── Type guard ──────────────────────────────────────────────────────────────

/**
 * Narrows `unknown` to `Record<string, unknown>`.
 * Shared across engine modules — replaces all `as Record<string, unknown>`
 * assertions with a proper type guard.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── RefTokenIR detection ────────────────────────────────────────────────────

/**
 * Type guard for serialised RefTokenIR objects embedded in compiled specs.
 * After compilation, RefToken instances are replaced with `{ $ref: { resource, path } }`.
 */
function isRefTokenIR(value: unknown): value is RefTokenIR {
  if (typeof value !== "object" || value === null) return false;
  if (!("$ref" in value)) return false;
  const ref = value.$ref;
  if (typeof ref !== "object" || ref === null) return false;
  if (!("resource" in ref) || !("path" in ref)) return false;
  return typeof ref.resource === "string" && typeof ref.path === "string";
}

// ─── Ref resolution ──────────────────────────────────────────────────────────

/**
 * Walk a compiled spec and replace every RefTokenIR with the concrete value
 * from the state map. By the time a resource is processed, all of its
 * dependencies have been read and their states stored in the map.
 *
 * @throws Error if a ref target is not in the state map (missing dependency)
 */
export function resolveRefs(
  spec: unknown,
  stateMap: Map<string, unknown>,
): unknown {
  if (isRefTokenIR(spec)) {
    const state = stateMap.get(spec.$ref.resource);
    if (state === undefined) {
      throw new Error(
        `Unresolved ref: resource "${spec.$ref.resource}" not yet in state map (path: ${spec.$ref.path})`,
      );
    }
    return getNestedValue(state, spec.$ref.path);
  }

  if (Array.isArray(spec)) {
    return spec.map((item) => resolveRefs(item, stateMap));
  }

  if (isRecord(spec)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(spec)) {
      result[key] = resolveRefs(value, stateMap);
    }
    return result;
  }

  return spec;
}

/**
 * Walk a dot-notation path through a nested object to retrieve the value.
 * e.g. getNestedValue(state, "encryption.kmsKeyId") returns state.encryption.kmsKeyId
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }

  return current;
}

// ─── Secret resolution ───────────────────────────────────────────────────────

/**
 * Walk a provider config and replace every SecretSourceIR with its resolved value.
 * Currently supports `env` kind — reads from `process.env`.
 *
 * @throws Error if a secret cannot be resolved
 */
export function resolveConfigSecrets(
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    result[key] = resolveSecretValue(value);
  }
  return result;
}

function resolveSecretValue(value: unknown): unknown {
  if (isSecretSourceIR(value)) {
    return resolveSecret(value.$secret);
  }
  if (Array.isArray(value)) {
    return value.map(resolveSecretValue);
  }
  if (isRecord(value)) {
    return resolveConfigSecrets(value);
  }
  return value;
}

function isSecretSourceIR(value: unknown): value is SecretSourceIR {
  if (typeof value !== "object" || value === null) return false;
  if (!("$secret" in value)) return false;
  const secret = value.$secret;
  if (typeof secret !== "object" || secret === null) return false;
  if (!("kind" in secret) || !("name" in secret)) return false;
  return secret.kind === "env" && typeof secret.name === "string";
}

function resolveSecret(descriptor: {
  readonly kind: string;
  readonly name: string;
}): string {
  if (descriptor.kind === "env") {
    const envValue = process.env[descriptor.name];
    if (envValue === undefined) {
      throw new Error(
        `Secret not found: environment variable "${descriptor.name}" is not set`,
      );
    }
    return envValue;
  }
  throw new Error(`Unknown secret kind: "${descriptor.kind}"`);
}

// ─── Deep equality ───────────────────────────────────────────────────────────

/**
 * Structural deep equality comparison for plain JSON-like values.
 * Used by the engine to compare desired state against actual state
 * for convergence checking.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]),
    );
  }

  return false;
}

// ─── Zod issue formatting ────────────────────────────────────────────────────

/** A human-readable issue collected during sync execution. */
export interface ResourceIssue {
  readonly resource: string;
  readonly message: string;
}

/**
 * Convert a Zod safeParse error into ResourceIssue entries.
 * Works with Zod 4's error shape — extracts path and message from each issue.
 */
export function collectZodIssues(
  resource: string,
  error: {
    readonly issues: readonly {
      readonly path: readonly unknown[];
      readonly message: string;
    }[];
  },
): ResourceIssue[] {
  return error.issues.map((issue) => ({
    resource,
    message:
      issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
  }));
}
