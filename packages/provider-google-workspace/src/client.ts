/**
 * Auth + thin Cloud Identity REST client for the Google Workspace adapter.
 *
 * Targets the Inbound SAML SSO Profiles API
 * (https://cloud.google.com/identity/docs/reference/rest/v1/inboundSamlSsoProfiles).
 *
 * The Cloud Identity REST surface is not covered by the Admin SDK
 * (Directory API) generated clients, so it is reached directly via
 * `google-auth-library`'s `request()`. Each method returns `Promise<unknown>` —
 * callers validate with Zod at their boundaries.
 *
 * Authentication: either OAuth2 user (refresh token) or service account with
 * domain-wide delegation. Both auth clients expose a uniform `request()` that
 * attaches the appropriate `Authorization` header.
 */

import * as z from "zod";
import { OAuth2Client, GoogleAuth } from "google-auth-library";
import type { GaxiosOptions, GaxiosResponse } from "gaxios";

/**
 * Minimal request surface shared by `OAuth2Client` and `GoogleAuth`.
 *
 * The library's `AuthClient` base does not include `GoogleAuth` itself, but
 * both expose this exact `request<T>(opts)` signature — capturing it as a
 * structural type lets the adapter accept either without a type assertion.
 */
export interface GoogleRequester {
  request<T>(opts: GaxiosOptions): Promise<GaxiosResponse<T>>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Required OAuth scope for inboundSamlSsoProfiles read/write operations. */
const INBOUND_SSO_SCOPE =
  "https://www.googleapis.com/auth/cloud-identity.inboundsso";

/** Base URL for the Cloud Identity REST API. */
const CLOUD_IDENTITY_BASE = "https://cloudidentity.googleapis.com/v1";

/** Initial backoff for LRO polling, in milliseconds. */
const LRO_POLL_INITIAL_MS = 500;
/** Maximum backoff between LRO polls, in milliseconds. */
const LRO_POLL_MAX_MS = 4000;
/** Maximum total wait for an LRO before giving up, in milliseconds. */
const LRO_POLL_TIMEOUT_MS = 60_000;

// ─── Service-account key parsing ─────────────────────────────────────────────

/**
 * Minimal shape of a Google service-account JSON key used for
 * domain-wide-delegated auth. Additional fields are tolerated by `loose`.
 */
const serviceAccountKeySchema = z.looseObject({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key: z.string().trim().min(1),
  token_uri: z.url().optional(),
});

export type ServiceAccountKey = z.infer<typeof serviceAccountKeySchema>;

/**
 * Parse a service-account key JSON string with full validation.
 *
 * `JSON.parse` returns `any` — we assign to `unknown` and validate via Zod
 * rather than casting.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const parsed: unknown = JSON.parse(raw);
  const result = serviceAccountKeySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid Google service account key JSON: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
    );
  }
  return result.data;
}

// ─── Auth construction ──────────────────────────────────────────────────────

export interface OAuthUserAuthOptions {
  readonly kind: "oauth-user";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

export interface ServiceAccountAuthOptions {
  readonly kind: "service-account";
  readonly serviceAccountKey: string;
  readonly subjectEmail: string;
}

export type AuthOptions = OAuthUserAuthOptions | ServiceAccountAuthOptions;

/**
 * Build a usable requester (OAuth2 client or GoogleAuth) ready for
 * `request()` calls against the Cloud Identity API.
 */
export function buildRequester(options: AuthOptions): GoogleRequester {
  if (options.kind === "oauth-user") {
    const oauthClient = new OAuth2Client({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    });
    oauthClient.setCredentials({ refresh_token: options.refreshToken });
    return oauthClient;
  }

  const credentials = parseServiceAccountKey(options.serviceAccountKey);
  return new GoogleAuth({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },
    scopes: [INBOUND_SSO_SCOPE],
    clientOptions: { subject: options.subjectEmail },
  });
}

// ─── Long-running operation polling ──────────────────────────────────────────

/**
 * Cloud Identity LRO response shape. `done: true` means terminal; either
 * `response` or `error` will be present.
 */
const operationSchema = z.looseObject({
  name: z.string().trim(),
  done: z.boolean().optional(),
  response: z.looseObject({}).optional(),
  error: z
    .looseObject({
      code: z.number().optional(),
      message: z.string().trim().optional(),
    })
    .optional(),
});

export type Operation = z.infer<typeof operationSchema>;

export interface OperationError {
  readonly code: number | undefined;
  readonly message: string;
}

/**
 * Poll a Cloud Identity long-running operation until it reaches a terminal
 * state. Returns the resolved `response` payload, or throws if the operation
 * reports an error or times out.
 */
export class CloudIdentityClient {
  /**
   * Customer scope for list queries. Threaded into the Cloud Identity
   * `filter` query parameter as `customer=="customers/${customerId}"` so
   * multi-tenant scenarios get the correct scope. See
   * https://cloud.google.com/identity/docs/reference/rest/v1/inboundSamlSsoProfiles/list#query-parameters
   */
  constructor(
    private readonly auth: GoogleRequester,
    private readonly customerId: string,
  ) {}

  async getProfile(profileId: string): Promise<unknown> {
    const response = await this.auth.request<unknown>({
      url: `${CLOUD_IDENTITY_BASE}/inboundSamlSsoProfiles/${profileId}`,
      method: "GET",
    });
    return response.data;
  }

  async listProfiles(extraFilter?: string): Promise<unknown> {
    const customerFilter = `customer=="customers/${this.customerId}"`;
    const filter =
      extraFilter === undefined
        ? customerFilter
        : `${customerFilter} ${extraFilter}`;
    const response = await this.auth.request<unknown>({
      url: `${CLOUD_IDENTITY_BASE}/inboundSamlSsoProfiles`,
      method: "GET",
      params: { filter },
    });
    return response.data;
  }

  async createProfile(body: Record<string, unknown>): Promise<unknown> {
    const response = await this.auth.request<unknown>({
      url: `${CLOUD_IDENTITY_BASE}/inboundSamlSsoProfiles`,
      method: "POST",
      data: body,
    });
    return this.awaitOperation(response.data);
  }

  async updateProfile(
    profileId: string,
    updateMask: readonly string[],
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.auth.request<unknown>({
      url: `${CLOUD_IDENTITY_BASE}/inboundSamlSsoProfiles/${profileId}`,
      method: "PATCH",
      params: { updateMask: updateMask.join(",") },
      data: body,
    });
    return this.awaitOperation(response.data);
  }

  async getOperation(operationName: string): Promise<unknown> {
    const response = await this.auth.request<unknown>({
      url: `${CLOUD_IDENTITY_BASE}/${operationName}`,
      method: "GET",
    });
    return response.data;
  }

  /**
   * Wait for an LRO to complete and return its `response` payload.
   *
   * Backoff doubles on each iteration up to `LRO_POLL_MAX_MS`. The total
   * elapsed wall time is capped by `LRO_POLL_TIMEOUT_MS`.
   */
  private async awaitOperation(initial: unknown): Promise<unknown> {
    let current = parseOperation(initial);
    const started = Date.now();
    let delay = LRO_POLL_INITIAL_MS;

    while (current.done !== true) {
      const elapsed = Date.now() - started;
      if (elapsed >= LRO_POLL_TIMEOUT_MS) {
        throw new OperationTimeoutError(current.name, LRO_POLL_TIMEOUT_MS);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, LRO_POLL_MAX_MS);
      const next = await this.getOperation(current.name);
      current = parseOperation(next);
    }

    if (current.error !== undefined) {
      throw new OperationFailedError(current.name, {
        code: current.error.code,
        message: current.error.message ?? "operation failed without a message",
      });
    }

    if (current.response === undefined) {
      throw new OperationFailedError(current.name, {
        code: undefined,
        message: "operation finished without a response payload",
      });
    }

    return current.response;
  }
}

function parseOperation(raw: unknown): Operation {
  const result = operationSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Cloud Identity operation response failed validation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
    );
  }
  return result.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class OperationTimeoutError extends Error {
  constructor(
    public readonly operationName: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Cloud Identity operation "${operationName}" did not complete within ${String(timeoutMs)}ms`,
    );
    this.name = "OperationTimeoutError";
  }
}

export class OperationFailedError extends Error {
  constructor(
    public readonly operationName: string,
    public readonly failure: OperationError,
  ) {
    super(
      `Cloud Identity operation "${operationName}" failed${failure.code === undefined ? "" : ` (code ${String(failure.code)})`}: ${failure.message}`,
    );
    this.name = "OperationFailedError";
  }
}

/**
 * Narrowing helper — returns the client or throws if not connected.
 * Used by resource handlers that receive `CloudIdentityClient | undefined`
 * from the registry.
 */
export function requireClient(
  client: CloudIdentityClient | undefined,
): CloudIdentityClient {
  if (client === undefined) {
    throw new Error(
      "Google Workspace provider not connected — call connect() first",
    );
  }
  return client;
}
