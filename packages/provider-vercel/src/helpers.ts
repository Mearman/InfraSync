/**
 * Shared helpers for Vercel resource adapters.
 */

import { ProviderApiError } from "@infrasync/core/errors";

/**
 * Extract the provider-assigned ID from a Vercel resource state object.
 *
 * All Vercel resources use an `id: string` field.
 */
export function getStateId(state: unknown): string {
  if (typeof state === "object" && state !== null && "id" in state) {
    if (typeof state.id === "string") return state.id;
  }
  throw new ProviderApiError("vercel", "getStateId", [
    {
      path: ["id"],
      message: "State object does not contain a valid 'id' field",
    },
  ]);
}

/**
 * Extract the provider-assigned ID from a Vercel resource state object
 * that uses `uid` instead of `id` (e.g. environment variables).
 */
export function getStateUid(state: unknown): string {
  if (typeof state === "object" && state !== null && "uid" in state) {
    if (typeof state.uid === "string") return state.uid;
  }
  throw new ProviderApiError("vercel", "getStateUid", [
    {
      path: ["uid"],
      message: "State object does not contain a valid 'uid' field",
    },
  ]);
}
