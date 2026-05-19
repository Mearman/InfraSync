import type { Client } from "@microsoft/microsoft-graph-client";
import type { ResourcePort } from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import { ProviderApiError } from "@infrasync/core/errors";
import * as z from "zod";
import {
  PROVIDER_NAME,
  getStateId,
  isNotFound,
  toProviderApiError,
} from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface UserRefs {
  readonly id: RefToken;
  readonly userPrincipalName: RefToken;
}

export const buildUserRefs: RefBuilder<UserRefs> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  userPrincipalName: new RefToken(resourceName, "userPrincipalName"),
});

// ─── Spec schema ─────────────────────────────────────────────────────────────

/**
 * ISO 3166-1 alpha-2 country codes are exactly two characters.
 * Microsoft Graph requires this `usageLocation` for licence assignment.
 */
const ISO_COUNTRY_CODE_LENGTH = 2;

const passwordProfileSchema = z.strictObject({
  password: z.string().trim().min(1),
  forceChangePasswordNextSignIn: z.boolean().optional(),
});

export const userSpecSchema = z.strictObject({
  kind: z.literal("User"),
  name: z.string().trim().min(1),
  userPrincipalName: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  mailNickname: z.string().trim().min(1),
  accountEnabled: z.boolean(),
  usageLocation: z.string().trim().length(ISO_COUNTRY_CODE_LENGTH),
  userType: z.enum(["Member", "Guest"]).default("Member"),
  passwordProfile: passwordProfileSchema,
});

export type UserSpec = z.infer<typeof userSpecSchema>;

// ─── State schema ────────────────────────────────────────────────────────────

/**
 * Provider-returned state for an Entra ID user.
 *
 * The Graph API only echoes fields explicitly requested through `$select`, but
 * adapter reads always select the full convergence set (see
 * `USER_SELECT_FIELDS`), so every desired-state field is guaranteed present.
 * State and desired-state are therefore symmetric — both require the same
 * fields. Anything optional here would re-introduce the convergence failure
 * Finding #2 fixes.
 */
const userStateSchema = z
  .looseObject({
    id: z.string().trim().min(1),
    userPrincipalName: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    mailNickname: z.string().trim().min(1),
    accountEnabled: z.boolean(),
    usageLocation: z.string().trim().length(ISO_COUNTRY_CODE_LENGTH),
    userType: z.string().trim().min(1),
  })
  .brand<"EntraIdUserState">()
  .readonly();

// ─── Identity and desired-state sub-schemas ──────────────────────────────────

const userIdentitySchema = userSpecSchema.pick({
  kind: true,
  userPrincipalName: true,
});

/**
 * Convergence schema — picks only the mutable, diffable fields.
 *
 * `kind` and `userPrincipalName` are identity fields handled by
 * `userIdentitySchema`; they cannot change between desired and actual without
 * meaning a different resource entirely, so including them in the convergence
 * comparison would be semantically wrong.
 *
 * `passwordProfile` is write-only — the Graph API never returns it, so it
 * cannot be diffed against state.
 *
 * Rebuilt as a `z.object` (loose) — `userSpecSchema` is a `z.strictObject` so
 * `.pick()` would propagate strict-mode and reject the identity fields the
 * engine still passes through in `resolvedSpec`. The spread-from-shape
 * idiom changes strictness while preserving each field's exact validator.
 */
const userDesiredStateSchema = z.object({
  displayName: userSpecSchema.shape.displayName,
  mailNickname: userSpecSchema.shape.mailNickname,
  accountEnabled: userSpecSchema.shape.accountEnabled,
  usageLocation: userSpecSchema.shape.usageLocation,
  userType: userSpecSchema.shape.userType,
});

// ─── API response validation ─────────────────────────────────────────────────

/**
 * Fields requested via Graph's `$select` query parameter on every user read.
 * Graph omits fields that hold their default values unless asked for explicitly,
 * so without `$select` the response is missing the very attributes convergence
 * needs to compare. With every convergence field listed here, the response is
 * guaranteed to carry each field, the desired-state schema can require them
 * symmetrically, and convergence will reliably report no-op.
 *
 * Kept in sync with `userDesiredStateSchema` (plus `id` for state identity).
 */
const USER_SELECT_FIELDS = [
  "id",
  "userPrincipalName",
  "displayName",
  "mailNickname",
  "accountEnabled",
  "usageLocation",
  "userType",
] as const;

const apiResponseSchema = z.looseObject({
  id: z.string().trim().min(1),
  userPrincipalName: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  mailNickname: z.string().trim().min(1),
  accountEnabled: z.boolean(),
  usageLocation: z.string().trim().length(ISO_COUNTRY_CODE_LENGTH),
  userType: z.string().trim().min(1),
});

function validateApiResponse(
  raw: unknown,
  operation: string,
): z.infer<typeof apiResponseSchema> {
  const result = apiResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new ProviderApiError(PROVIDER_NAME, operation, result.error.issues);
  }
  return result.data;
}

// ─── Request body builders ───────────────────────────────────────────────────

/**
 * Build the body for `POST /users`. Includes every spec field — Graph
 * requires the password profile at creation time.
 */
function buildCreateBody(spec: UserSpec): Record<string, unknown> {
  return {
    userPrincipalName: spec.userPrincipalName,
    displayName: spec.displayName,
    mailNickname: spec.mailNickname,
    accountEnabled: spec.accountEnabled,
    usageLocation: spec.usageLocation,
    userType: spec.userType,
    passwordProfile: {
      password: spec.passwordProfile.password,
      ...(spec.passwordProfile.forceChangePasswordNextSignIn === undefined
        ? {}
        : {
            forceChangePasswordNextSignIn:
              spec.passwordProfile.forceChangePasswordNextSignIn,
          }),
    },
  };
}

/**
 * Build the body for `PATCH /users/{id}`. Excludes `passwordProfile` and
 * `userPrincipalName` — the password is not part of convergence and the UPN
 * is the identity field, not a mutable attribute via this path.
 */
function buildUpdateBody(spec: UserSpec): Record<string, unknown> {
  return {
    displayName: spec.displayName,
    mailNickname: spec.mailNickname,
    accountEnabled: spec.accountEnabled,
    usageLocation: spec.usageLocation,
    userType: spec.userType,
  };
}

// ─── Resource implementation ────────────────────────────────────────────────

export class UserResource implements ResourcePort<
  typeof userSpecSchema,
  typeof userStateSchema
> {
  readonly kind = "User";
  readonly specSchema = userSpecSchema;
  readonly stateSchema = userStateSchema;
  readonly identitySchema = userIdentitySchema;
  readonly desiredStateSchema = userDesiredStateSchema;

  constructor(private readonly client: Client) {}

  getStateId = getStateId;

  /**
   * Fetch a user by id-or-UPN and return its validated state.
   *
   * Always requests the full convergence set through `$select` so the response
   * carries every field the engine compares — Graph omits default-valued
   * attributes (for example `userType` when "Member", `accountEnabled` when
   * `true`) unless asked for explicitly, and a missing field on the actual
   * side breaks the desired-state comparison.
   */
  private async fetchUser(
    idOrUpn: string,
    operation: string,
  ): Promise<z.infer<typeof apiResponseSchema>> {
    const raw: unknown = await this.client
      .api(`/users/${encodeURIComponent(idOrUpn)}`)
      .select([...USER_SELECT_FIELDS])
      .get();
    return validateApiResponse(raw, operation);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = userSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "read", parsed.error.issues);
    }
    try {
      return await this.fetchUser(parsed.data.userPrincipalName, "read");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "read");
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = userSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "create", parsed.error.issues);
    }
    try {
      const created: unknown = await this.client
        .api("/users")
        .post(buildCreateBody(parsed.data));
      // POST returns the created user but is not subject to `$select`, and
      // may omit default-valued fields. Re-fetch with `$select` so the
      // returned state is symmetric with `read()` / `update()` and the
      // desired-state schema parses every field.
      const id = extractCreatedId(created);
      return await this.fetchUser(id, "create");
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "create");
    }
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = userSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "update", parsed.error.issues);
    }
    try {
      await this.client
        .api(`/users/${encodeURIComponent(id)}`)
        .patch(buildUpdateBody(parsed.data));
      // PATCH returns 204 No Content — re-read for canonical state.
      return await this.fetchUser(id, "update");
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "update");
    }
  }
}

/**
 * Extract the `id` of a freshly created user from a Graph POST response.
 *
 * POST `/users` returns the created entity with `id` populated, but the
 * response shape is not subject to `$select` and may omit other fields.
 * Only `id` is consumed here — the canonical state is fetched via a follow-up
 * `GET` with `$select`.
 */
function extractCreatedId(raw: unknown): string {
  const result = z.looseObject({ id: z.string().trim().min(1) }).safeParse(raw);
  if (!result.success) {
    throw new ProviderApiError(PROVIDER_NAME, "create", result.error.issues);
  }
  return result.data.id;
}
