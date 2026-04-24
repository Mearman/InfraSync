import { z } from "zod";
import type { RefTokenIR } from "../ir/types.js";

// ─── RefToken class ──────────────────────────────────────────────────────────

/**
 * A symbolic reference from a spec field to another resource's state field.
 *
 * T is a phantom type parameter representing the resolved value type.
 * It is not present at runtime — it exists only for compile-time type safety
 * so that `refable(z.string())` accepts `RefToken<string>` but not `RefToken<boolean>`.
 *
 * Using a class avoids type assertions — the generic parameter is carried
 * by the class itself, not by any runtime value.
 */
export class RefToken<T = unknown> {
  /** @internal Phantom type — never read at runtime */
  declare readonly _type: T;

  constructor(
    readonly resource: string,
    readonly path: string,
  ) {}
}

// ─── Runtime helpers ─────────────────────────────────────────────────────────

/** Type guard: checks whether a value is a RefToken. */
export function isRefToken(value: unknown): value is RefToken {
  return value instanceof RefToken;
}

// ─── RefToken → InfraIR conversion ──────────────────────────────────────────

/** Convert a runtime RefToken into its serialisable IR form. */
export function refTokenToIR(token: RefToken): RefTokenIR {
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
  return z.union([
    inner,
    z.custom<RefToken<z.infer<T>>>((v) => v instanceof RefToken),
  ]);
}
