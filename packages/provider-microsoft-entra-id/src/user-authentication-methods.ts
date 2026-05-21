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

export interface UserAuthenticationMethodsRefs {
  readonly id: RefToken;
  readonly userPrincipalName: RefToken;
  readonly methodTypes: RefToken;
}

export const buildUserAuthenticationMethodsRefs: RefBuilder<
  UserAuthenticationMethodsRefs
> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  userPrincipalName: new RefToken(resourceName, "userPrincipalName"),
  methodTypes: new RefToken(resourceName, "methodTypes"),
});

// ─── Method type mapping ─────────────────────────────────────────────────────

/**
 * Maps Graph API `@odata.type` values to short method type names and their
 * type-specific deletion endpoints.
 *
 * Password methods cannot be deleted — they are always present on every user.
 * The Graph API requires type-specific endpoints for deletion (e.g.
 * `/softwareOathMethods/{id}`); the generic `/methods/{id}` endpoint does not
 * support DELETE.
 *
 * Source: https://learn.microsoft.com/en-us/graph/api/resources/authenticationmethods-overview?view=graph-rest-1.0
 */
const METHOD_TYPE_INFO: Record<
  string,
  { shortName: string; deletable: boolean; deleteEndpoint: string }
> = {
  "#microsoft.graph.passwordAuthenticationMethod": {
    shortName: "password",
    deletable: false,
    deleteEndpoint: "",
  },
  "#microsoft.graph.softwareOathAuthenticationMethod": {
    shortName: "softwareOath",
    deletable: true,
    deleteEndpoint: "softwareOathMethods",
  },
  "#microsoft.graph.microsoftAuthenticatorAuthenticationMethod": {
    shortName: "microsoftAuthenticator",
    deletable: true,
    deleteEndpoint: "microsoftAuthenticatorMethods",
  },
  "#microsoft.graph.phoneAuthenticationMethod": {
    shortName: "phone",
    deletable: true,
    deleteEndpoint: "phoneMethods",
  },
  "#microsoft.graph.fido2AuthenticationMethod": {
    shortName: "fido2",
    deletable: true,
    deleteEndpoint: "fido2Methods",
  },
  "#microsoft.graph.emailAuthenticationMethod": {
    shortName: "email",
    deletable: true,
    deleteEndpoint: "emailMethods",
  },
  "#microsoft.graph.temporaryAccessPassAuthenticationMethod": {
    shortName: "temporaryAccessPass",
    deletable: true,
    deleteEndpoint: "temporaryAccessPassMethods",
  },
};

/**
 * Short names for the authentication method types that InfraSync can manage.
 * Used in the spec's `methodTypes` array and in convergence comparison.
 */
const authMethodTypeSchema = z.enum([
  "password",
  "softwareOath",
  "microsoftAuthenticator",
  "phone",
  "fido2",
  "email",
  "temporaryAccessPass",
]);

/**
 * Derive a short method type name from an `@odata.type` that isn't in the
 * known mapping. Strips the `#microsoft.graph.` prefix and the
 * `AuthenticationMethod` suffix, then lower-cases the first character.
 */
function extractMethodType(odataType: string): string {
  const stripped = odataType
    .replace("#microsoft.graph.", "")
    .replace(/AuthenticationMethod$/, "");
  return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}

// ─── Spec schema ─────────────────────────────────────────────────────────────

/**
 * Spec for a `UserAuthenticationMethods` resource.
 *
 * `methodTypes` declares the complete set of authentication method types the
 * user should have. Any method type present in actual state but absent from
 * this list will be deleted (except `password`, which cannot be removed).
 * `password` must always be included since every user has a password method.
 */
export const userAuthenticationMethodsSpecSchema = z.strictObject({
  kind: z.literal("UserAuthenticationMethods"),
  name: z.string().trim().min(1).optional(),
  userPrincipalName: z.string().trim().min(1),
  methodTypes: z.array(authMethodTypeSchema).min(1),
});

export type UserAuthenticationMethodsSpec = z.infer<
  typeof userAuthenticationMethodsSpecSchema
>;

/**
 * Runtime validation that `methodTypes` includes 'password'. Enforced at the
 * resource layer (read/create/update) rather than in the schema because Zod v4
 * does not allow `.pick()` on schemas with `.refine()`.
 */
function validatePasswordRequired(
  spec: UserAuthenticationMethodsSpec,
  operation: string,
): void {
  if (!spec.methodTypes.includes("password")) {
    throw new ProviderApiError(PROVIDER_NAME, operation, [
      {
        path: ["methodTypes"],
        message:
          "methodTypes must include 'password' — every user has a password method that cannot be removed",
      },
    ]);
  }
}

// ─── State schema ────────────────────────────────────────────────────────────

const userAuthenticationMethodsStateSchema = z
  .looseObject({
    id: z.string().trim().min(1),
    userPrincipalName: z.string().trim().min(1),
    methodTypes: z.array(z.string().trim().min(1)),
  })
  .brand<"EntraIdUserAuthenticationMethodsState">()
  .readonly();

// ─── Identity and desired-state sub-schemas ──────────────────────────────────

const identitySchema = userAuthenticationMethodsSpecSchema.pick({
  kind: true,
  userPrincipalName: true,
});

const desiredStateSchema = z.object({
  methodTypes: userAuthenticationMethodsSpecSchema.shape.methodTypes,
});

// ─── API response validation ─────────────────────────────────────────────────

const apiMethodSchema = z.looseObject({
  "@odata.type": z.string().trim().min(1),
  id: z.string().trim().min(1),
});

const apiMethodListSchema = z.looseObject({
  value: z.array(apiMethodSchema),
});

const apiUserIdSchema = z.looseObject({
  id: z.string().trim().min(1),
});

interface ResolvedMethod {
  readonly id: string;
  readonly odataType: string;
  readonly shortName: string;
  readonly deletable: boolean;
  readonly deleteEndpoint: string;
}

// ─── Resource implementation ────────────────────────────────────────────────

export class UserAuthenticationMethodsResource implements ResourcePort<
  typeof userAuthenticationMethodsSpecSchema,
  typeof userAuthenticationMethodsStateSchema
> {
  readonly kind = "UserAuthenticationMethods";
  readonly specSchema = userAuthenticationMethodsSpecSchema;
  readonly stateSchema = userAuthenticationMethodsStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  constructor(private readonly client: Client) {}

  getStateId = getStateId;

  /**
   * Fetch the user's object ID and list of registered authentication methods.
   */
  private async fetchUserMethods(
    upn: string,
    operation: string,
  ): Promise<{ userId: string; methods: ResolvedMethod[] }> {
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
      .api(`/users/${encodeURIComponent(upn)}/authentication/methods`)
      .get();

    const methodsResult = apiMethodListSchema.safeParse(rawMethods);
    if (!methodsResult.success) {
      throw new ProviderApiError(
        PROVIDER_NAME,
        operation,
        methodsResult.error.issues,
      );
    }

    const methods: ResolvedMethod[] = methodsResult.data.value.map((m) => {
      const info = METHOD_TYPE_INFO[m["@odata.type"]];
      return {
        id: m.id,
        odataType: m["@odata.type"],
        shortName: info?.shortName ?? extractMethodType(m["@odata.type"]),
        deletable: info?.deletable ?? true,
        deleteEndpoint: info?.deleteEndpoint ?? "",
      };
    });

    return { userId: userResult.data.id, methods };
  }

  /**
   * Build the canonical state from the user's current authentication methods.
   */
  private buildState(
    userId: string,
    upn: string,
    methods: ResolvedMethod[],
  ): { id: string; userPrincipalName: string; methodTypes: string[] } {
    return {
      id: userId,
      userPrincipalName: upn,
      methodTypes: methods.map((m) => m.shortName),
    };
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = userAuthenticationMethodsSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "read", parsed.error.issues);
    }
    validatePasswordRequired(parsed.data, "read");

    try {
      const { userId, methods } = await this.fetchUserMethods(
        parsed.data.userPrincipalName,
        "read",
      );
      return this.buildState(userId, parsed.data.userPrincipalName, methods);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "read");
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = userAuthenticationMethodsSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "create", parsed.error.issues);
    }
    validatePasswordRequired(parsed.data, "create");

    try {
      await this.enforcePolicy(parsed.data);
      const { userId, methods } = await this.fetchUserMethods(
        parsed.data.userPrincipalName,
        "create",
      );
      return this.buildState(userId, parsed.data.userPrincipalName, methods);
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "create");
    }
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = userAuthenticationMethodsSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "update", parsed.error.issues);
    }
    validatePasswordRequired(parsed.data, "update");

    try {
      await this.enforcePolicy(parsed.data);
      const { userId, methods } = await this.fetchUserMethods(
        parsed.data.userPrincipalName,
        "update",
      );
      return this.buildState(userId, parsed.data.userPrincipalName, methods);
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "update");
    }
  }

  /**
   * Delete any authentication methods on the user that are not in the
   * allowed `methodTypes` set. Password methods are never deleted because
   * they cannot be removed.
   *
   * Tolerates 404 on individual deletions — the method may have been removed
   * between the list call and the delete call (race condition or manual
   * intervention).
   */
  private async enforcePolicy(
    spec: UserAuthenticationMethodsSpec,
  ): Promise<void> {
    const { methods } = await this.fetchUserMethods(
      spec.userPrincipalName,
      "update",
    );

    // Widen to Set<string> so shortName (string) can be checked
    // against the narrower AuthMethodType literal union.
    const allowedSet: ReadonlySet<string> = new Set(spec.methodTypes);
    const toDelete = methods.filter(
      (m) => m.deletable && !allowedSet.has(m.shortName),
    );

    for (const method of toDelete) {
      try {
        await this.client
          .api(
            `/users/${encodeURIComponent(spec.userPrincipalName)}/authentication/${method.deleteEndpoint}/${method.id}`,
          )
          .delete();
      } catch (error) {
        // Tolerate 404 — method was already gone between list and delete.
        if (!isNotFound(error)) throw error;
      }
    }
  }
}
