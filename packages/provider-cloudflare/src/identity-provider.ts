import Cloudflare from "cloudflare";
import type {
  IdentityProviderCreateParams,
  IdentityProviderUpdateParams,
} from "cloudflare/resources/zero-trust/identity-providers/identity-providers.js";
import type {
  ResourcePort,
  ResourceCodec,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";
import { getStateId } from "./helpers.js";

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
const idpConfigSchema = z.record(z.string(), z.json());

export const identityProviderSpecSchema = z.object({
  kind: z.literal("IdentityProvider"),
  name: z.string().trim().min(1),
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
    id: z.string().trim(),
    name: z.string().trim(),
    type: z.string().trim(),
    scim_config: z.json().optional(),
  })
  .brand<"CloudflareIdpState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  name: z.string().trim(),
  type: z.string().trim(),
  scim_config: z.json().optional(),
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

// ─── Codec schemas ──────────────────────────────────────────────────────────
//
// The codec maps only bidirectionally mappable fields.
// config is write-only (not returned in state) — not in the codec.
// It belongs in desiredStateSchema for spec comparison, not here.

const idpTypeEnumSchema = z.enum([
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
]);

const codecInputSchema = z.object({
  kind: z.literal("IdentityProvider"),
  name: z.string().trim().min(1),
  type: idpTypeEnumSchema,
});

const IDP_KIND = "IdentityProvider" as const;

const codecOutputSchema = z.looseObject({
  name: z.string().trim(),
  type: z.string().trim(),
});

const identityProviderZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.name,
    type: spec.type,
  }),
  encode: (state) => ({
    kind: IDP_KIND,
    name: state.name,
    type: idpTypeEnumSchema.parse(state.type),
  }),
});

const cloudflareIdpCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return identityProviderZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return identityProviderZodCodec.decode(result.data);
  },
};

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
  readonly codec = cloudflareIdpCodec;

  readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  constructor(
    private readonly client: Cloudflare,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = identityProviderSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    const idps = await this.client.zeroTrust.identityProviders.list({
      account_id: this.resolvedScopes.get("accountId"),
    });
    const match = idps.result.find((idp) => {
      if (
        "name" in idp &&
        typeof idp.name === "string" &&
        "type" in idp &&
        typeof idp.type === "string"
      ) {
        return idp.name === parsed.data.name && idp.type === parsed.data.type;
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

    const params = buildCreateParams(
      this.resolvedScopes.get("accountId"),
      name,
      type,
      config,
    );
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

    const params = buildUpdateParams(
      this.resolvedScopes.get("accountId"),
      name,
      type,
      config,
    );
    const response = await this.client.zeroTrust.identityProviders.update(
      id,
      params,
    );

    return validateApiResponse(response, "update");
  }
}
