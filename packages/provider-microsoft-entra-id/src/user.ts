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

const userStateSchema = z
  .looseObject({
    id: z.string().trim().min(1),
    userPrincipalName: z.string().trim().min(1),
    displayName: z.string().trim().optional(),
    mailNickname: z.string().trim().optional(),
    accountEnabled: z.boolean().optional(),
    usageLocation: z.string().trim().optional(),
    userType: z.string().trim().optional(),
  })
  .brand<"EntraIdUserState">()
  .readonly();

// ─── Identity and desired-state sub-schemas ──────────────────────────────────

const userIdentitySchema = userSpecSchema.pick({
  kind: true,
  userPrincipalName: true,
});

/**
 * `passwordProfile` is write-only — the Graph API never returns it, so it
 * cannot be diffed against state. Every other spec field participates in
 * convergence.
 */
const userDesiredStateSchema = userSpecSchema.pick({
  kind: true,
  userPrincipalName: true,
  displayName: true,
  mailNickname: true,
  accountEnabled: true,
  usageLocation: true,
  userType: true,
});

// ─── API response validation ─────────────────────────────────────────────────

const apiResponseSchema = z.looseObject({
  id: z.string().trim().min(1),
  userPrincipalName: z.string().trim().min(1),
  displayName: z.string().trim().optional(),
  mailNickname: z.string().trim().optional(),
  accountEnabled: z.boolean().optional(),
  usageLocation: z.string().trim().optional(),
  userType: z.string().trim().optional(),
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

  async read(spec: unknown): Promise<unknown> {
    const parsed = userSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "read", parsed.error.issues);
    }
    try {
      const raw: unknown = await this.client
        .api(`/users/${encodeURIComponent(parsed.data.userPrincipalName)}`)
        .get();
      return validateApiResponse(raw, "read");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw toProviderApiError(error, "read");
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = userSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "create", parsed.error.issues);
    }
    try {
      const raw: unknown = await this.client
        .api("/users")
        .post(buildCreateBody(parsed.data));
      return validateApiResponse(raw, "create");
    } catch (error) {
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
      const raw: unknown = await this.client
        .api(`/users/${encodeURIComponent(id)}`)
        .get();
      return validateApiResponse(raw, "update");
    } catch (error) {
      throw toProviderApiError(error, "update");
    }
  }
}
