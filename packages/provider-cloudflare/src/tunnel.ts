import Cloudflare from "cloudflare";
import type {
  CloudflaredCreateParams,
  CloudflaredEditParams,
} from "cloudflare/resources/zero-trust/tunnels/cloudflared/cloudflared.js";
import type {
  ResourcePort,
  ResourceCodec,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync/core/provider";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";
import { getStateId, findByName } from "./helpers.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const tunnelSpecSchema = z.object({
  kind: z.literal("Tunnel"),
  /** Tunnel name (identity field) */
  name: z.string().trim().min(1),
  /** Configuration source: local (YAML on origin) or cloudflare (dashboard) */
  configSrc: z.enum(["local", "cloudflare"]).optional(),
  /**
   * Tunnel secret — base64-encoded, minimum 32 bytes.
   * Only used on create. Updates use a separate secret rotation API.
   */
  tunnelSecret: z.string().trim().min(1).optional(),
});

export type TunnelSpec = z.infer<typeof tunnelSpecSchema>;

const resolvedSpecSchema = z.object({
  kind: z.literal("Tunnel"),
  name: z.string().trim().min(1),
  configSrc: z.enum(["local", "cloudflare"]).optional(),
  tunnelSecret: z.string().trim().min(1).optional(),
});

const tunnelStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim(),
    status: z.enum(["inactive", "degraded", "healthy", "down"]).optional(),
    config_src: z.enum(["local", "cloudflare"]).optional(),
    tun_type: z
      .enum([
        "cfd_tunnel",
        "warp_connector",
        "warp",
        "magic",
        "ip_sec",
        "gre",
        "cni",
      ])
      .optional(),
    created_at: z.string().trim().optional(),
    deleted_at: z.string().trim().optional(),
    conns_active_at: z.string().trim().optional(),
    conns_inactive_at: z.string().trim().optional(),
  })
  .brand<"CloudflareTunnelState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  name: z.string().trim(),
  status: z.string().trim().optional(),
  config_src: z.string().trim().optional(),
  tun_type: z.string().trim().optional(),
  created_at: z.string().trim().optional(),
  deleted_at: z.string().trim().optional(),
  conns_active_at: z.string().trim().optional(),
  conns_inactive_at: z.string().trim().optional(),
});

const identitySchema = tunnelSpecSchema.pick({ name: true });

const desiredStateSchema = tunnelSpecSchema.pick({
  configSrc: true,
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

function buildCreateParams(
  accountId: string,
  name: string,
  configSrc: "local" | "cloudflare" | undefined,
  tunnelSecret: string | undefined,
): CloudflaredCreateParams {
  const params: CloudflaredCreateParams = {
    account_id: accountId,
    name,
  };
  if (configSrc !== undefined) params.config_src = configSrc;
  if (tunnelSecret !== undefined) params.tunnel_secret = tunnelSecret;
  return params;
}

function buildEditParams(
  accountId: string,
  name: string | undefined,
  tunnelSecret: string | undefined,
): CloudflaredEditParams {
  const params: CloudflaredEditParams = {
    account_id: accountId,
  };
  if (name !== undefined) params.name = name;
  if (tunnelSecret !== undefined) params.tunnel_secret = tunnelSecret;
  return params;
}

// ─── Codec schemas ───────────────────────────────────────────────────────────

const configSrcEnumSchema = z.enum(["local", "cloudflare"]);

const codecInputSchema = z.object({
  kind: z.literal("Tunnel"),
  name: z.string().trim().min(1),
  configSrc: configSrcEnumSchema.optional(),
});

const TUNNEL_KIND = "Tunnel" as const;

const codecOutputSchema = z.looseObject({
  name: z.string().trim(),
  config_src: z.string().trim().optional(),
});

const tunnelZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.name,
    config_src: spec.configSrc,
  }),
  encode: (state) => ({
    kind: TUNNEL_KIND,
    name: state.name,
    configSrc:
      state.config_src !== undefined
        ? configSrcEnumSchema.parse(state.config_src)
        : undefined,
  }),
});

const cloudflareTunnelCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return tunnelZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return tunnelZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class TunnelResource implements ResourcePort<
  typeof tunnelSpecSchema,
  typeof tunnelStateSchema
> {
  readonly kind = "Tunnel";
  readonly specSchema = tunnelSpecSchema;
  readonly stateSchema = tunnelStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = cloudflareTunnelCodec;

  readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  constructor(
    private readonly client: Cloudflare,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = tunnelSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    const tunnels = await this.client.zeroTrust.tunnels.cloudflared.list({
      account_id: this.resolvedScopes.get("accountId"),
    });
    const match = findByName(tunnels.result, parsed.data.name);
    if (match === undefined) return undefined;
    return validateApiResponse(match, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }
    const { name, configSrc, tunnelSecret } = parsed.data;

    const params = buildCreateParams(
      this.resolvedScopes.get("accountId"),
      name,
      configSrc,
      tunnelSecret,
    );
    const response =
      await this.client.zeroTrust.tunnels.cloudflared.create(params);

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }
    const { name, tunnelSecret } = parsed.data;

    const params = buildEditParams(
      this.resolvedScopes.get("accountId"),
      name,
      tunnelSecret,
    );
    const response = await this.client.zeroTrust.tunnels.cloudflared.edit(
      id,
      params,
    );

    return validateApiResponse(response, "update");
  }
}
