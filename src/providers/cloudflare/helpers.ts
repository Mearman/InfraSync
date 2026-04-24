/**
 * Shared helpers for Cloudflare resource adapters.
 */

import { ProviderApiError } from "../../core/errors.js";

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
