import { z } from "zod";
import type { RefTokenIR } from "../ir/types.js";

// ─── Brand symbol ────────────────────────────────────────────────────────────

/**
 * Unique brand symbol for RefToken. Used by isRefToken() to distinguish
 * ref tokens from plain objects at runtime.
 */
const RefTokenBrand: unique symbol = Symbol("infrasync:ref-token");

// ─── Internal interface (runtime shape) ──────────────────────────────────────

/** The runtime representation of a RefToken — no phantom type parameter. */
interface RefTokenInternal {
  readonly [RefTokenBrand]: true;
  readonly resource: string;
  readonly path: string;
}

// ─── Public interface (phantom-typed) ────────────────────────────────────────

/**
 * A symbolic reference from a spec field to another resource's state field.
 *
 * T is a phantom type parameter representing the resolved value type.
 * It is not present at runtime — it exists only for compile-time type safety
 * so that `.ref.websiteEndpoint` carries the correct type through to `refable()`.
 */
export interface RefToken<T> extends RefTokenInternal {
  /** @internal Phantom type — never read at runtime */
  readonly _type: T;
}

// ─── Runtime helpers ─────────────────────────────────────────────────────────

/** Type guard: checks whether a value is a RefToken. */
export function isRefToken(value: unknown): value is RefToken<unknown> {
  return typeof value === "object" && value !== null && RefTokenBrand in value;
}

/**
 * Create a RefToken with a phantom type parameter.
 *
 * The type assertion to RefToken<T> is unavoidable — phantom types cannot be
 * materialised at runtime. T carries compile-time information only; it ensures
 * that `.ref.websiteEndpoint` (RefToken<string>) cannot be assigned to a field
 * expecting RefToken<number>.
 */
export function createRefToken<T>(resource: string, path: string): RefToken<T> {
  const token: RefTokenInternal = Object.freeze({
    [RefTokenBrand]: true as const,
    resource,
    path,
  });
  // Phantom type: T is compile-time only. RefToken<T> extends RefTokenInternal
  // so the structural overlap is sufficient for a single-assertion cast.
  // No `as unknown as` needed — the brand symbol provides the structural link.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- unavoidable: phantom type T cannot be materialised at runtime
  return token as RefToken<T>;
}

// ─── RefToken → InfraIR conversion ──────────────────────────────────────────

/** Convert a runtime RefToken into its serialisable IR form. */
export function refTokenToIR(token: RefToken<unknown>): RefTokenIR {
  return Object.freeze({
    $ref: Object.freeze({
      resource: token.resource,
      path: token.path,
    }),
  });
}

// ─── refable() ───────────────────────────────────────────────────────────────

/**
 * Creates a Zod union schema that accepts either the inner schema's type
 * or a RefToken<T>. Used for spec fields whose values might come from
 * another resource's state at execution time.
 *
 * Example: `refable(z.string())` accepts `string | RefToken<string>`.
 */
export function refable<T extends z.ZodType>(inner: T) {
  return z.union([inner, z.custom<RefToken<z.infer<T>>>((v) => isRefToken(v))]);
}
