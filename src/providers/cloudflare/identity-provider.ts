import Cloudflare from "cloudflare";
import type {
  IdentityProviderCreateParams,
  IdentityProviderUpdateParams,
} from "cloudflare/resources/zero-trust/identity-providers/identity-providers.js";
import type { ResourcePort } from "../../core/provider.js";
import { RefToken } from "../../core/refs.js";
import type { RefBuilder } from "../../authoring/handles.js";
import { z } from "zod";
import { ProviderApiError } from "../../core/errors.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface IdentityProviderRefs {
  readonly id: RefToken;
  readonly name: RefToken;
  readonly type: RefToken;
}

export const buildIdentityProviderRefs: RefBuilder<IdentityProviderRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
  type: new RefToken(resourceName, "type"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Identity provider config schema.
 *
 * The Cloudflare SDK models each IdP type's config as a specific interface
 * (e.g. `AccessOIDC.Config`). Our spec accepts arbitrary objects — the exact
 * fields depend on the IdP type. The SDK validates at the API boundary.
 */
const idpConfigSchema = z.record(z.string(), z.unknown());

export const identityProviderSpecSchema = z.object({
  kind: z.literal("IdentityProvider"),
  name: z.string().min(1),
  type: z.enum([
    "oidc",
    "saml",
    "google-apps",
    "github",
    "azureAD",
    "okta",
    "onelogin",
    "centrify",
    "facebook",
    "linkedin",
    "google",
    "pingone",
    "yandex",
    "onetimepin",
  ]),
  config: idpConfigSchema,
});

export type IdentityProviderSpec = z.infer<typeof identityProviderSpecSchema>;

const identityProviderStateSchema = z
  .looseObject({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    scim_config: z.unknown().optional(),
  })
  .brand<"CloudflareIdpState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  scim_config: z.unknown().optional(),
});

const identitySchema = identityProviderSpecSchema.pick({ name: true });
const desiredStateSchema = identityProviderSpecSchema.pick({
  type: true,
  config: true,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateApiResponse(
  raw: unknown,
  operation: string,
): z.infer<typeof apiResponseSchema> {
  const result = apiResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new ProviderApiError("cloudflare", operation, result.error.issues);
  }
  return result.data;
}

/**
 * Build SDK-typed create params for an OIDC identity provider.
 *
 * The Cloudflare SDK's `IdentityProviderCreateParams` is a non-discriminated
 * union with 14 variants. We build the `AccessOIDC` variant explicitly.
 * Since the IdP type determines which config shape is valid, and the SDK
 * validates at the API boundary, we pass our Zod-validated config through.
 */
function buildCreateParams(
  accountId: string,
  name: string,
  type:
    | "oidc"
    | "saml"
    | "google-apps"
    | "github"
    | "azureAD"
    | "okta"
    | "onelogin"
    | "centrify"
    | "facebook"
    | "linkedin"
    | "google"
    | "pingone"
    | "yandex"
    | "onetimepin",
  config: Record<string, unknown>,
): IdentityProviderCreateParams.AccessOIDC {
  return {
    account_id: accountId,
    name,
    type: type,
    config,
  };
}

function buildUpdateParams(
  accountId: string,
  name: string,
  type:
    | "oidc"
    | "saml"
    | "google-apps"
    | "github"
    | "azureAD"
    | "okta"
    | "onelogin"
    | "centrify"
    | "facebook"
    | "linkedin"
    | "google"
    | "pingone"
    | "yandex"
    | "onetimepin",
  config: Record<string, unknown>,
): IdentityProviderUpdateParams.AccessOIDC {
  return {
    account_id: accountId,
    name,
    type: type,
    config,
  };
}

// ─── Resource implementation ─────────────────────────────────────────────────

export class IdentityProviderResource implements ResourcePort<
  typeof identityProviderSpecSchema,
  typeof identityProviderStateSchema
> {
  readonly kind = "IdentityProvider";
  readonly specSchema = identityProviderSpecSchema;
  readonly stateSchema = identityProviderStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  constructor(
    private readonly client: Cloudflare,
    private readonly accountId: string,
  ) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      const obj = state;
      if ("id" in obj && typeof obj.id === "string") return obj.id;
    }
    throw new ProviderApiError("cloudflare", "getStateId", [
      {
        path: ["id"],
        message: "State object does not contain a valid 'id' field",
      },
    ]);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = identityProviderSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    const idps = await this.client.zeroTrust.identityProviders.list({
      account_id: this.accountId,
    });
    const match = idps.result.find((idp) => {
      if ("name" in idp && typeof idp.name === "string") {
        return idp.name === parsed.data.name;
      }
      return false;
    });

    if (match === undefined) return undefined;
    return validateApiResponse(match, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = identityProviderSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }
    const { name, type, config } = parsed.data;

    const params = buildCreateParams(this.accountId, name, type, config);
    const response =
      await this.client.zeroTrust.identityProviders.create(params);

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = identityProviderSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }
    const { name, type, config } = parsed.data;

    const params = buildUpdateParams(this.accountId, name, type, config);
    const response = await this.client.zeroTrust.identityProviders.update(
      id,
      params,
    );

    return validateApiResponse(response, "update");
  }
}
