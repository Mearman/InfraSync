/**
 * Shared helpers for name.com resource adapters.
 */

import { ProviderApiError } from "@infrasync/core/errors";

/**
 * Extract the provider-assigned ID from a name.com resource state object.
 * name.com uses numeric IDs (returned as numbers from the API).
 */
export function getStateId(state: unknown): string {
  if (typeof state === "object" && state !== null && "id" in state) {
    if (typeof state.id === "number" || typeof state.id === "string") {
      return String(state.id);
    }
  }
  throw new ProviderApiError("namecom", "getStateId", [
    {
      path: ["id"],
      message: "State object does not contain a valid 'id' field",
    },
  ]);
}
