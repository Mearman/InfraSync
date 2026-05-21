import { GraphError } from "@microsoft/microsoft-graph-client";
import { ProviderApiError } from "@infrasync-org/core/errors";

const PROVIDER_NAME = "microsoft-entra-id";
const HTTP_NOT_FOUND = 404;

/**
 * Extract the provider-assigned id from a state object.
 * Every Entra ID resource state exposes a top-level `id` string.
 */
export function getStateId(state: unknown): string {
  if (typeof state === "object" && state !== null && "id" in state) {
    if (typeof state.id === "string") return state.id;
  }
  throw new ProviderApiError(PROVIDER_NAME, "getStateId", [
    {
      path: ["id"],
      message: "State object does not contain a valid 'id' field",
    },
  ]);
}

/**
 * Convert an arbitrary thrown value from the Graph SDK into a structured
 * `ProviderApiError`. 404s are not errors at this layer — callers translate
 * them into `undefined` for `read()`.
 *
 * If the error is already a `ProviderApiError` (for example, thrown by
 * `validateApiResponse()` / `validateSingle()` when API-response Zod
 * validation fails), it is returned unchanged so the structured `issues`
 * array is preserved. Wrapping a `ProviderApiError` in another
 * `ProviderApiError` would discard those issues by collapsing them into
 * the outer error's generic `message`.
 */
export function toProviderApiError(
  error: unknown,
  operation: string,
): ProviderApiError {
  if (error instanceof ProviderApiError) return error;
  if (error instanceof GraphError) {
    return new ProviderApiError(PROVIDER_NAME, operation, [
      {
        path: [],
        message: `Graph API error ${String(error.statusCode)}: ${error.message}`,
      },
    ]);
  }
  if (error instanceof Error) {
    return new ProviderApiError(PROVIDER_NAME, operation, [
      { path: [], message: error.message },
    ]);
  }
  return new ProviderApiError(PROVIDER_NAME, operation, [
    { path: [], message: "unknown error from Graph SDK" },
  ]);
}

/**
 * True if the error is a Graph 404 — the canonical signal that a resource
 * lookup found nothing. Also tolerates plain Error objects with a
 * `statusCode` property of 404, which the Graph SDK can throw in some
 * configurations.
 */
export function isNotFound(error: unknown): boolean {
  if (error instanceof GraphError && error.statusCode === HTTP_NOT_FOUND)
    return true;
  if (
    error instanceof Error &&
    "statusCode" in error &&
    hasStatusCodeValue(error, HTTP_NOT_FOUND)
  )
    return true;
  return false;
}

function hasStatusCodeValue(
  error: Error & { statusCode?: unknown },
  expected: number,
): boolean {
  return error.statusCode === expected;
}

export { PROVIDER_NAME };
