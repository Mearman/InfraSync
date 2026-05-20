/**
 * Shared helpers for the Google Workspace resource adapters.
 */

import { ProviderApiError } from "@infrasync-org/core/errors";
import { OperationFailedError, OperationTimeoutError } from "./client.js";

/**
 * Normalise an unknown error caught from a Cloud Identity call into a
 * `ProviderApiError`.
 *
 * The engine's error boundary in `sync.ts` only catches `ProviderApiError`.
 * `OperationTimeoutError` and `OperationFailedError` are LRO-specific
 * exceptions thrown by the polling code in `client.ts` — without this
 * adapter, they would bubble out of the engine and crash the entire sync run
 * instead of being collected as a per-resource failure.
 *
 * `ProviderApiError` instances are re-thrown unchanged so their structured
 * issues survive. Everything else — LRO errors, unknown exceptions — is
 * wrapped in a fresh `ProviderApiError` whose single issue carries the
 * underlying error message.
 */
export function toProviderApiError(
  error: unknown,
  operation: string,
): ProviderApiError {
  if (error instanceof ProviderApiError) {
    return error;
  }
  if (
    error instanceof OperationTimeoutError ||
    error instanceof OperationFailedError
  ) {
    return new ProviderApiError("google-workspace", operation, [
      { path: [], message: error.message },
    ]);
  }
  if (error instanceof Error) {
    return new ProviderApiError("google-workspace", operation, [
      { path: [], message: error.message },
    ]);
  }
  return new ProviderApiError("google-workspace", operation, [
    { path: [], message: "Unknown error thrown during Cloud Identity call" },
  ]);
}
