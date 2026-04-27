import Cloudflare from "cloudflare";
import type {
  ApplicationCreateParams,
  ApplicationUpdateParams,
} from "cloudflare/resources/zero-trust/access/applications/applications.js";
import type {
  ResourcePort,
  ResourceCodec,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync/core/provider";
import { RefToken, refable } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";
import { getStateId } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface AccessApplicationRefs {
  readonly id: RefToken;
  readonly domain: RefToken;
  readonly name: RefToken;
  readonly aud: RefToken;
}

export const buildAccessApplicationRefs: RefBuilder<AccessApplicationRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  domain: new RefToken(resourceName, "domain"),
  name: new RefToken(resourceName, "name"),
  aud: new RefToken(resourceName, "aud"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const accessApplicationSpecSchema = z.object({
  kind: z.literal("AccessApplication"),
  /** The domain and path that Access will secure (identity field) */
  domain: z.string().trim().min(1),
  type: z.literal("self_hosted").default("self_hosted"),
  name: z.string().trim().min(1),
  sessionDuration: z.string().trim().optional(),
  autoRedirectToIdentity: z.boolean().optional(),
  appLauncherVisible: z.boolean().optional(),
  allowedIdps: z.array(refable(z.string().trim())).optional(),
});

export type AccessApplicationSpec = z.infer<typeof accessApplicationSpecSchema>;

const accessApplicationStateSchema = z
  .looseObject({
    id: z.string().trim(),
    domain: z.string().trim(),
    type: z.string().trim(),
    name: z.string().trim(),
    aud: z.string().trim().optional(),
    session_duration: z.string().trim().optional(),
    auto_redirect_to_identity: z.boolean().optional(),
    app_launcher_visible: z.boolean().optional(),
    allowed_idps: z.array(z.json()).optional(),
    created_at: z.string().trim().optional(),
    updated_at: z.string().trim().optional(),
  })
  .brand<"CloudflareAccessAppState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  domain: z.string().trim(),
  type: z.string().trim(),
  name: z.string().trim(),
  aud: z.string().trim().optional(),
  session_duration: z.string().trim().optional(),
  auto_redirect_to_identity: z.boolean().optional(),
  app_launcher_visible: z.boolean().optional(),
  allowed_idps: z.array(z.json()).optional(),
  created_at: z.string().trim().optional(),
  updated_at: z.string().trim().optional(),
});

const resolvedAppSpecSchema = z.object({
  kind: z.literal("AccessApplication"),
  domain: z.string().trim().min(1),
  type: z.literal("self_hosted").optional(),
  name: z.string().trim().min(1),
  sessionDuration: z.string().trim().optional(),
  autoRedirectToIdentity: z.boolean().optional(),
  appLauncherVisible: z.boolean().optional(),
  allowedIdps: z.array(z.string().trim()).optional(),
});

const identitySchema = accessApplicationSpecSchema.pick({ domain: true });

const desiredStateSchema = accessApplicationSpecSchema.pick({
  name: true,
  sessionDuration: true,
  autoRedirectToIdentity: true,
  appLauncherVisible: true,
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
 * Build the SDK parameters for a self-hosted application create/update.
 *
 * The Cloudflare SDK's `ApplicationCreateParams` / `ApplicationUpdateParams`
 * are non-discriminated unions — `type` is `ApplicationTypeParam` (a broad
 * string union), not a literal. TypeScript therefore checks our object against
 * every union member, including `BrowserRdpApplication` which requires
 * `target_criteria`. We satisfy only the `SelfHostedApplication` variant,
 * which is the one we actually use.
 */
function buildSelfHostedParams(
  accountId: string,
  domain: string,
  name: string,
  sessionDuration: string | undefined,
  autoRedirectToIdentity: boolean | undefined,
  appLauncherVisible: boolean | undefined,
  allowedIdps: readonly string[] | undefined,
): ApplicationCreateParams.SelfHostedApplication {
  const params: ApplicationCreateParams.SelfHostedApplication = {
    account_id: accountId,
    domain,
    type: "self_hosted",
    name,
  };
  if (sessionDuration !== undefined) params.session_duration = sessionDuration;
  if (autoRedirectToIdentity !== undefined)
    params.auto_redirect_to_identity = autoRedirectToIdentity;
  if (appLauncherVisible !== undefined)
    params.app_launcher_visible = appLauncherVisible;
  if (allowedIdps !== undefined) params.allowed_idps = [...allowedIdps];
  return params;
}

function buildSelfHostedUpdateParams(
  accountId: string,
  domain: string,
  name: string,
  sessionDuration: string | undefined,
  autoRedirectToIdentity: boolean | undefined,
  appLauncherVisible: boolean | undefined,
  allowedIdps: readonly string[] | undefined,
): ApplicationUpdateParams.SelfHostedApplication {
  const params: ApplicationUpdateParams.SelfHostedApplication = {
    account_id: accountId,
    domain,
    type: "self_hosted",
    name,
  };
  if (sessionDuration !== undefined) params.session_duration = sessionDuration;
  if (autoRedirectToIdentity !== undefined)
    params.auto_redirect_to_identity = autoRedirectToIdentity;
  if (appLauncherVisible !== undefined)
    params.app_launcher_visible = appLauncherVisible;
  if (allowedIdps !== undefined) params.allowed_idps = [...allowedIdps];
  return params;
}

// ─── Codec schemas ──────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("AccessApplication"),
  domain: z.string().trim().min(1),
  type: z.literal("self_hosted").optional(),
  name: z.string().trim().min(1),
  sessionDuration: z.string().trim().optional(),
  autoRedirectToIdentity: z.boolean().optional(),
  appLauncherVisible: z.boolean().optional(),
  allowedIdps: z.array(z.string().trim()).optional(),
});

const ACCESS_APP_KIND = "AccessApplication" as const;

const codecOutputSchema = z.looseObject({
  domain: z.string().trim(),
  type: z.string().trim().optional(),
  name: z.string().trim(),
  session_duration: z.string().trim().optional(),
  auto_redirect_to_identity: z.boolean().optional(),
  app_launcher_visible: z.boolean().optional(),
  allowed_idps: z.array(z.json()).optional(),
});

const accessAppZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    domain: spec.domain,
    type: spec.type,
    name: spec.name,
    session_duration: spec.sessionDuration,
    auto_redirect_to_identity: spec.autoRedirectToIdentity,
    app_launcher_visible: spec.appLauncherVisible,
    allowed_idps: spec.allowedIdps,
  }),
  encode: (state) => ({
    kind: ACCESS_APP_KIND,
    domain: state.domain,
    name: state.name,
    sessionDuration: state.session_duration,
    autoRedirectToIdentity: state.auto_redirect_to_identity,
    appLauncherVisible: state.app_launcher_visible,
    allowedIdps: Array.isArray(state.allowed_idps)
      ? state.allowed_idps.map((idp) =>
          typeof idp === "string" ? idp : JSON.stringify(idp),
        )
      : undefined,
  }),
});

const cloudflareAccessAppCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return accessAppZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return accessAppZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class AccessApplicationResource implements ResourcePort<
  typeof accessApplicationSpecSchema,
  typeof accessApplicationStateSchema
> {
  readonly kind = "AccessApplication";
  readonly specSchema = accessApplicationSpecSchema;
  readonly stateSchema = accessApplicationStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = cloudflareAccessAppCodec;

  readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  constructor(
    private readonly client: Cloudflare,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = accessApplicationSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    const apps = await this.client.zeroTrust.access.applications.list({
      account_id: this.resolvedScopes.get("accountId"),
    });
    const match = apps.result.find((app) => {
      if ("domain" in app && typeof app.domain === "string") {
        return app.domain === parsed.data.domain;
      }
      return false;
    });

    if (match === undefined) return undefined;
    return validateApiResponse(match, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = resolvedAppSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }
    const {
      domain,
      name,
      sessionDuration,
      autoRedirectToIdentity,
      appLauncherVisible,
      allowedIdps,
    } = parsed.data;

    const params = buildSelfHostedParams(
      this.resolvedScopes.get("accountId"),
      domain,
      name,
      sessionDuration,
      autoRedirectToIdentity,
      appLauncherVisible,
      allowedIdps,
    );
    const response =
      await this.client.zeroTrust.access.applications.create(params);

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedAppSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }
    const {
      domain,
      name,
      sessionDuration,
      autoRedirectToIdentity,
      appLauncherVisible,
      allowedIdps,
    } = parsed.data;

    const params = buildSelfHostedUpdateParams(
      this.resolvedScopes.get("accountId"),
      domain,
      name,
      sessionDuration,
      autoRedirectToIdentity,
      appLauncherVisible,
      allowedIdps,
    );
    const response = await this.client.zeroTrust.access.applications.update(
      id,
      params,
    );

    return validateApiResponse(response, "update");
  }
}
