/**
 * InboundSamlSsoProfile — Cloud Identity Inbound SAML SSO Profile.
 *
 * Configures Google Workspace as a SAML *service provider* receiving SSO
 * assertions from an external identity provider (e.g. Okta, AD FS, or any
 * third-party IdP that authenticates users into Google).
 *
 * This is NOT the resource for "Google as IdP for a third-party SP" (the
 * direction used when federating Google Workspace into Microsoft 365 for
 * sign-in). Google does not currently expose a stable programmable API for
 * that direction; see the package README for details.
 *
 * Wraps the `inboundSamlSsoProfiles` REST surface
 * (https://cloud.google.com/identity/docs/reference/rest/v1/inboundSamlSsoProfiles).
 * Sibling `InboundSsoAssignment` resources are out of scope for the initial
 * implementation — admins (or a future resource) wire assignments separately.
 */

import * as z from "zod";
import type { ResourcePort } from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import { ProviderApiError } from "@infrasync/core/errors";
import { CloudIdentityClient, requireClient } from "./client.js";
import { toProviderApiError } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface InboundSamlSsoProfileRefs {
  readonly id: RefToken;
  readonly name: RefToken;
  readonly displayName: RefToken;
}

export const buildInboundSamlSsoProfileRefs: RefBuilder<
  InboundSamlSsoProfileRefs
> = (resourceName) => ({
  /** The numeric/UUID portion of `inboundSamlSsoProfiles/{id}`. */
  id: new RefToken(resourceName, "id"),
  /** The full resource name (`inboundSamlSsoProfiles/{id}`). */
  name: new RefToken(resourceName, "name"),
  /** Echo of the spec `displayName`. */
  displayName: new RefToken(resourceName, "displayName"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

const idpConfigSchema = z.strictObject({
  entityId: z.url(),
  singleSignOnServiceUri: z.url(),
  logoutRedirectUri: z.url().optional(),
  changePasswordUri: z.url().optional(),
});

const spConfigSchema = z.strictObject({
  entityId: z.string().trim().min(1),
  assertionConsumerServiceUri: z.url(),
});

export const inboundSamlSsoProfileSpecSchema = z.strictObject({
  kind: z.literal("InboundSamlSsoProfile"),
  /** Identity field — Google does not expose a stable user-controllable name. */
  displayName: z.string().trim().min(1),
  idpConfig: idpConfigSchema,
  spConfig: spConfigSchema,
});

export type InboundSamlSsoProfileSpec = z.infer<
  typeof inboundSamlSsoProfileSpecSchema
>;

const inboundSamlSsoProfileStateSchema = z
  .looseObject({
    /** Full resource name (`inboundSamlSsoProfiles/{id}`). */
    name: z.string().trim(),
    displayName: z.string().trim(),
    idpConfig: z
      .looseObject({
        entityId: z.string().trim(),
        singleSignOnServiceUri: z.string().trim(),
        logoutRedirectUri: z.string().trim().optional(),
        changePasswordUri: z.string().trim().optional(),
      })
      .optional(),
    spConfig: z
      .looseObject({
        entityId: z.string().trim(),
        assertionConsumerServiceUri: z.string().trim().optional(),
      })
      .optional(),
  })
  .brand<"GoogleInboundSamlSsoProfileState">()
  .readonly();

const inboundSamlSsoProfileIdentitySchema =
  inboundSamlSsoProfileSpecSchema.pick({
    kind: true,
    displayName: true,
  });

const inboundSamlSsoProfileDesiredStateSchema =
  inboundSamlSsoProfileSpecSchema.pick({
    displayName: true,
    idpConfig: true,
    spConfig: true,
  });

// ─── API response schemas ────────────────────────────────────────────────────

const profileResponseSchema = z.looseObject({
  name: z.string().trim(),
  displayName: z.string().trim(),
  idpConfig: z.looseObject({}).optional(),
  spConfig: z.looseObject({}).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the trailing ID segment of a Cloud Identity resource name such as
 * `inboundSamlSsoProfiles/01abc23def`.
 */
function extractProfileId(resourceName: string): string {
  const slash = resourceName.lastIndexOf("/");
  if (slash === -1 || slash === resourceName.length - 1) {
    throw new ProviderApiError("google-workspace", "extractProfileId", [
      {
        path: ["name"],
        message: `Cannot extract profile id from resource name "${resourceName}"`,
      },
    ]);
  }
  return resourceName.slice(slash + 1);
}

function validateProfileResponse(
  raw: unknown,
  operation: string,
): z.infer<typeof profileResponseSchema> {
  const result = profileResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new ProviderApiError(
      "google-workspace",
      operation,
      result.error.issues,
    );
  }
  return result.data;
}

interface ProfileBodyIdpConfig {
  readonly entityId: string;
  readonly singleSignOnServiceUri: string;
  readonly logoutRedirectUri?: string;
  readonly changePasswordUri?: string;
}

interface ProfileBodySpConfig {
  readonly entityId: string;
  readonly assertionConsumerServiceUri: string;
}

interface ProfileBody {
  readonly displayName: string;
  readonly idpConfig: ProfileBodyIdpConfig;
  readonly spConfig: ProfileBodySpConfig;
  [key: string]: unknown;
}

function buildProfileBody(spec: InboundSamlSsoProfileSpec): ProfileBody {
  const idpConfig: ProfileBodyIdpConfig = {
    entityId: spec.idpConfig.entityId,
    singleSignOnServiceUri: spec.idpConfig.singleSignOnServiceUri,
    ...(spec.idpConfig.logoutRedirectUri === undefined
      ? {}
      : { logoutRedirectUri: spec.idpConfig.logoutRedirectUri }),
    ...(spec.idpConfig.changePasswordUri === undefined
      ? {}
      : { changePasswordUri: spec.idpConfig.changePasswordUri }),
  };
  return {
    displayName: spec.displayName,
    idpConfig,
    spConfig: {
      entityId: spec.spConfig.entityId,
      assertionConsumerServiceUri: spec.spConfig.assertionConsumerServiceUri,
    },
  };
}

/** Field paths used in the PATCH updateMask. */
const SAML_APP_UPDATE_MASK: readonly string[] = [
  "displayName",
  "idpConfig.entityId",
  "idpConfig.singleSignOnServiceUri",
  "idpConfig.logoutRedirectUri",
  "idpConfig.changePasswordUri",
  "spConfig.entityId",
  "spConfig.assertionConsumerServiceUri",
];

// ─── Resource implementation ────────────────────────────────────────────────

export class InboundSamlSsoProfileResource implements ResourcePort<
  typeof inboundSamlSsoProfileSpecSchema,
  typeof inboundSamlSsoProfileStateSchema
> {
  readonly kind = "InboundSamlSsoProfile";
  readonly specSchema = inboundSamlSsoProfileSpecSchema;
  readonly stateSchema = inboundSamlSsoProfileStateSchema;
  readonly identitySchema = inboundSamlSsoProfileIdentitySchema;
  readonly desiredStateSchema = inboundSamlSsoProfileDesiredStateSchema;

  constructor(private readonly client: CloudIdentityClient | undefined) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "name" in state) {
      if (typeof state.name === "string" && state.name.length > 0) {
        return state.name;
      }
    }
    throw new ProviderApiError("google-workspace", "getStateId", [
      {
        path: ["name"],
        message:
          "State object does not contain a valid 'name' resource identifier",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = inboundSamlSsoProfileSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(
        "google-workspace",
        "read",
        parsed.error.issues,
      );
    }

    try {
      const profiles = await requireClient(this.client).listProfiles();
      for (const raw of profiles) {
        const parsedProfile = profileResponseSchema.safeParse(raw);
        if (!parsedProfile.success) {
          throw new ProviderApiError(
            "google-workspace",
            "read",
            parsedProfile.error.issues,
          );
        }
        if (parsedProfile.data.displayName === parsed.data.displayName) {
          return parsedProfile.data;
        }
      }
      return undefined;
    } catch (error) {
      throw toProviderApiError(error, "read");
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = inboundSamlSsoProfileSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(
        "google-workspace",
        "create",
        parsed.error.issues,
      );
    }

    const body = buildProfileBody(parsed.data);
    try {
      const response = await requireClient(this.client).createProfile(body);
      return validateProfileResponse(response, "create");
    } catch (error) {
      throw toProviderApiError(error, "create");
    }
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = inboundSamlSsoProfileSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(
        "google-workspace",
        "update",
        parsed.error.issues,
      );
    }

    const profileId = id.includes("/") ? extractProfileId(id) : id;
    const body = buildProfileBody(parsed.data);
    try {
      const response = await requireClient(this.client).updateProfile(
        profileId,
        SAML_APP_UPDATE_MASK,
        body,
      );
      return validateProfileResponse(response, "update");
    } catch (error) {
      throw toProviderApiError(error, "update");
    }
  }
}
