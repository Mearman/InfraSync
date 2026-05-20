/**
 * Shared helpers for Cloudflare resource adapters.
 */

import * as z from "zod";
import { ProviderApiError } from "@infrasync-org/core/errors";

/**
 * Extract the provider-assigned ID from a Cloudflare resource state object.
 *
 * All Cloudflare resources use an `id: string` field. This helper is shared
 * across all resource adapters to avoid duplication.
 */
export function getStateId(state: unknown): string {
  if (typeof state === "object" && state !== null && "id" in state) {
    if (typeof state.id === "string") return state.id;
  }
  throw new ProviderApiError("cloudflare", "getStateId", [
    {
      path: ["id"],
      message: "State object does not contain a valid 'id' field",
    },
  ]);
}

// ─── List response matching ──────────────────────────────────────────────────

/**
 * Lightweight schema for resources that carry a `name` field.
 * Used by `findByName` to narrow API list results without full schema validation.
 */
const nameBearerSchema = z.object({ name: z.string().trim() });

/**
 * Find a resource by name in a raw API list response.
 *
 * Parses each item through a minimal `name`-bearing schema, then matches
 * against the target name. Returns the raw item (not the parsed result) so
 * callers can validate with their full `apiResponseSchema` afterwards.
 *
 * This replaces the `Object.getOwnPropertyDescriptor` pattern used to narrow
 * `unknown` items from list results — Zod parsing is the correct boundary
 * validation, not runtime property descriptor access.
 */
export function findByName(
  items: readonly unknown[],
  targetName: string,
): unknown {
  for (const item of items) {
    const result = nameBearerSchema.safeParse(item);
    if (result.success && result.data.name === targetName) {
      return item;
    }
  }
  return undefined;
}

/**
 * Lightweight schema for resources that carry a `pattern` field.
 * Used by `findByPattern` to narrow Worker route list results.
 */
const patternBearerSchema = z.object({ pattern: z.string().trim() });

/**
 * Find a resource by pattern in a raw API list response.
 *
 * Same principle as `findByName` — Zod parsing at the boundary instead of
 * runtime property descriptor access.
 */
export function findByPattern(
  items: readonly unknown[],
  targetPattern: string,
): unknown {
  for (const item of items) {
    const result = patternBearerSchema.safeParse(item);
    if (result.success && result.data.pattern === targetPattern) {
      return item;
    }
  }
  return undefined;
}
