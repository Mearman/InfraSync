import type { Client } from "@microsoft/microsoft-graph-client";
import type { ResourcePort } from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import { ProviderApiError } from "@infrasync-org/core/errors";
import * as z from "zod";
import {
  PROVIDER_NAME,
  getStateId,
  isNotFound,
  toProviderApiError,
} from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface UserSoftwareOathMethodRefs {
  readonly id: RefToken;
  readonly userPrincipalName: RefToken;
  readonly methodId: RefToken;
}

export const buildUserSoftwareOathMethodRefs: RefBuilder<
  UserSoftwareOathMethodRefs
> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  userPrincipalName: new RefToken(resourceName, "userPrincipalName"),
  methodId: new RefToken(resourceName, "methodId"),
});

// ─── Spec schema ─────────────────────────────────────────────────────────────

/**
 * Spec for a `UserSoftwareOathMethod` resource.
 *
 * Ensures the user has a software OATH (TOTP) authentication method registered
 * with the given secret. The `secret` is write-only — the Graph API never
 * returns it, so it is excluded from convergence comparison (like the User
 * resource's `passwordProfile`).
 *
 * A user can have at most one softwareOath method. If one already exists, the
 * resource is satisfied. To rotate the secret, delete the InfraSync resource
 * and recreate it.
 *
 * Source: https://learn.microsoft.com/en-us/graph/api/resources/softwareoathauthenticationmethod?view=graph-rest-1.0
 */
export const userSoftwareOathMethodSpecSchema = z.strictObject({
  kind: z.literal("UserSoftwareOathMethod"),
  name: z.string().trim().min(1).optional(),
  userPrincipalName: z.string().trim().min(1),
  /** Base32-encoded TOTP secret (e.g. "JBSWY3DPEHPK3PXP"). */
  secret: z.string().trim().min(1),
});

export type UserSoftwareOathMethodSpec = z.infer<
  typeof userSoftwareOathMethodSpecSchema
>;

// ─── State schema ────────────────────────────────────────────────────────────

const userSoftwareOathMethodStateSchema = z
  .looseObject({
    id: z.string().trim().min(1),
    userPrincipalName: z.string().trim().min(1),
    methodType: z.literal("softwareOath"),
    methodId: z.string().trim().min(1),
  })
  .brand<"EntraIdUserSoftwareOathMethodState">()
  .readonly();

// ─── Identity and desired-state sub-schemas ──────────────────────────────────

const identitySchema = userSoftwareOathMethodSpecSchema.pick({
  kind: true,
  userPrincipalName: true,
});

/**
 * Convergence schema — includes only `methodType`.
 *
 * `secret` is write-only (the Graph API returns `null`), so it cannot be part
 * of the convergence comparison. This is the same pattern as the User
 * resource's `passwordProfile`.
 */
const desiredStateSchema = z.object({
  methodType: z.literal("softwareOath"),
});

// ─── API response validation ─────────────────────────────────────────────────

const apiSoftwareOathMethodSchema = z.looseObject({
  id: z.string().trim().min(1),
});

const apiSoftwareOathMethodListSchema = z.looseObject({
  value: z.array(apiSoftwareOathMethodSchema),
});

const apiUserIdSchema = z.looseObject({
  id: z.string().trim().min(1),
});

// ─── Resource implementation ────────────────────────────────────────────────

export class UserSoftwareOathMethodResource implements ResourcePort<
  typeof userSoftwareOathMethodSpecSchema,
  typeof userSoftwareOathMethodStateSchema
> {
  readonly kind = "UserSoftwareOathMethod";
  readonly specSchema = userSoftwareOathMethodSpecSchema;
  readonly stateSchema = userSoftwareOathMethodStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  constructor(private readonly client: Client) {}

  getStateId = getStateId;

  /**
   * Look up the user's object ID and current softwareOath methods.
   * Returns `undefined` if the user has no softwareOath method.
   */
  private async fetchSoftwareOathMethod(
    upn: string,
    operation: string,
  ): Promise<{ userId: string; methodId: string } | undefined> {
    const rawUser: unknown = await this.client
      .api(`/users/${encodeURIComponent(upn)}`)
      .select(["id"])
      .get();

    const userResult = apiUserIdSchema.safeParse(rawUser);
    if (!userResult.success) {
      throw new ProviderApiError(
        PROVIDER_NAME,
        operation,
        userResult.error.issues,
      );
    }

    const rawMethods: unknown = await this.client
      .api(
        `/users/${encodeURIComponent(upn)}/authentication/softwareOathMethods`,
      )
      .get();

    const methodsResult = apiSoftwareOathMethodListSchema.safeParse(rawMethods);
    if (!methodsResult.success) {
      throw new ProviderApiError(
        PROVIDER_NAME,
        operation,
        methodsResult.error.issues,
      );
    }

    if (methodsResult.data.value.length === 0) return undefined;

    // A user typically has at most one softwareOath method. Use the first.
    const method = methodsResult.data.value[0];
    if (method === undefined) return undefined;
    return { userId: userResult.data.id, methodId: method.id };
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = userSoftwareOathMethodSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "read", parsed.error.issues);
    }

    try {
      const result = await this.fetchSoftwareOathMethod(
        parsed.data.userPrincipalName,
        "read",
      );
      if (result === undefined) return undefined;
      return {
        id: result.userId,
        userPrincipalName: parsed.data.userPrincipalName,
        methodType: "softwareOath" as const,
        methodId: result.methodId,
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "read");
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = userSoftwareOathMethodSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "create", parsed.error.issues);
    }

    try {
      // POST the new softwareOath method with the TOTP secret.
      await this.client
        .api(
          `/users/${encodeURIComponent(parsed.data.userPrincipalName)}/authentication/softwareOathMethods`,
        )
        .post({ secret: parsed.data.secret });

      // Re-read for canonical state.
      const result = await this.fetchSoftwareOathMethod(
        parsed.data.userPrincipalName,
        "create",
      );
      if (result === undefined) {
        throw new ProviderApiError(PROVIDER_NAME, "create", [
          {
            path: [],
            message:
              "softwareOath method was not found after creation — the POST may have failed silently",
          },
        ]);
      }
      return {
        id: result.userId,
        userPrincipalName: parsed.data.userPrincipalName,
        methodType: "softwareOath" as const,
        methodId: result.methodId,
      };
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "create");
    }
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = userSoftwareOathMethodSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "update", parsed.error.issues);
    }

    try {
      // Find existing method to delete, then recreate with new secret.
      const existing = await this.fetchSoftwareOathMethod(
        parsed.data.userPrincipalName,
        "update",
      );
      if (existing !== undefined) {
        await this.client
          .api(
            `/users/${encodeURIComponent(parsed.data.userPrincipalName)}/authentication/softwareOathMethods/${existing.methodId}`,
          )
          .delete();
      }

      // POST the new method with the updated secret.
      await this.client
        .api(
          `/users/${encodeURIComponent(parsed.data.userPrincipalName)}/authentication/softwareOathMethods`,
        )
        .post({ secret: parsed.data.secret });

      // Re-read for canonical state.
      const result = await this.fetchSoftwareOathMethod(
        parsed.data.userPrincipalName,
        "update",
      );
      if (result === undefined) {
        throw new ProviderApiError(PROVIDER_NAME, "update", [
          {
            path: [],
            message:
              "softwareOath method was not found after update — the POST may have failed silently",
          },
        ]);
      }
      return {
        id: result.userId,
        userPrincipalName: parsed.data.userPrincipalName,
        methodType: "softwareOath" as const,
        methodId: result.methodId,
      };
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "update");
    }
  }
}
