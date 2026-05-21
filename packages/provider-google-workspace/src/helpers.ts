/**
 * Shared helpers for the Google Workspace resource adapters.
 */

import { ProviderApiError } from "@infrasync-org/core/errors";
import { OperationFailedError, OperationTimeoutError } from "./client.js";

const PROVIDER_NAME = "google-workspace";

/**
 * Normalise an unknown error caught from a Google API call into a
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
    return new ProviderApiError(PROVIDER_NAME, operation, [
      { path: [], message: error.message },
    ]);
  }
  if (error instanceof Error) {
    return new ProviderApiError(PROVIDER_NAME, operation, [
      { path: [], message: error.message },
    ]);
  }
  return new ProviderApiError(PROVIDER_NAME, operation, [
    { path: [], message: "Unknown error thrown during Google API call" },
  ]);
}

/**
 * True if the error is a Google API 404 — the canonical signal that a
 * resource lookup found nothing.
 *
 * Google API errors via `google-auth-library`/`gaxios` throw `GaxiosError`
 * with `response.status === 404` or `code === 404`. The error body may also
 * carry a structured JSON with `error.errors[0].reason === 'notFound'`.
 * This helper tolerates all known shapes.
 */
export function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // GaxiosError puts the HTTP status on `code` or `response.status`
  if ("code" in error && error.code === 404) return true;
  if ("response" in error) {
    const response = error.response;
    if (
      typeof response === "object" &&
      response !== null &&
      "status" in response &&
      response.status === 404
    )
      return true;
  }
  return false;
}

export { PROVIDER_NAME };
