import type {
  ResourcePort,
  ResourceScopes,
  ResolvedScopes,
  ResourceCodec,
} from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import { TailscaleClient, requireClient } from "./client.js";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface TailnetKeyRefs {
  readonly id: RefToken;
  readonly key: RefToken;
}

export const buildTailnetKeyRefs: RefBuilder<TailnetKeyRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  key: new RefToken(resourceName, "key"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const tailnetKeySpecSchema = z.object({
  kind: z.literal("TailnetKey"),
  /** Human-readable description */
  description: z.string().trim().min(1),
  /** Whether the key can be used multiple times */
  reusable: z.boolean(),
  /** Whether devices authenticated with this key are ephemeral */
  ephemeral: z.boolean(),
  /** Whether devices are automatically approved */
  preapproved: z.boolean().optional(),
  /** Tags to apply to devices authenticated with this key */
  tags: z.array(z.string().trim().min(1)).optional(),
  /** Key lifetime in seconds (default: 90 days) */
  expirySeconds: z.int().min(1).optional(),
});

export type TailnetKeySpec = z.infer<typeof tailnetKeySpecSchema>;

const tailnetKeyStateSchema = z
  .looseObject({
    id: z.string().trim(),
    key: z.string().trim(),
    description: z.string().trim().optional(),
    created: z.string().trim().optional(),
    expires: z.string().trim().optional(),
    capabilities: z
      .looseObject({
        devices: z.looseObject({
          create: z.looseObject({
            reusable: z.boolean().optional(),
            ephemeral: z.boolean().optional(),
            preapproved: z.boolean().optional(),
            tags: z.array(z.string().trim()).optional(),
          }),
        }),
      })
      .optional(),
  })
  .brand<"TailscaleTailnetKeyState">()
  .readonly();

const identitySchema = tailnetKeySpecSchema.pick({
  description: true,
});

const desiredStateSchema = tailnetKeySpecSchema.pick({
  description: true,
  reusable: true,
  ephemeral: true,
  tags: true,
});

// ─── Codec schemas ──────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("TailnetKey"),
  description: z.string().trim().min(1),
  reusable: z.boolean(),
  ephemeral: z.boolean(),
  preapproved: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  expirySeconds: z.int().min(1).optional(),
});

const TAILNET_KEY_KIND = "TailnetKey" as const;

const codecOutputSchema = z.looseObject({
  description: z.string().trim().optional(),
  capabilities: z
    .looseObject({
      devices: z.looseObject({
        create: z.looseObject({
          reusable: z.boolean().optional(),
          ephemeral: z.boolean().optional(),
          preapproved: z.boolean().optional(),
          tags: z.array(z.string().trim()).optional(),
        }),
      }),
    })
    .optional(),
});

const tailnetKeyZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    description: spec.description,
    capabilities: {
      devices: {
        create: {
          reusable: spec.reusable,
          ephemeral: spec.ephemeral,
          preapproved: spec.preapproved,
          tags: spec.tags,
        },
      },
    },
  }),
  encode: (state) => {
    const caps = state.capabilities;
    const create = caps !== undefined ? caps.devices.create : undefined;
    return {
      kind: TAILNET_KEY_KIND,
      description: state.description ?? "",
      reusable: create?.reusable ?? false,
      ephemeral: create?.ephemeral ?? false,
      preapproved: create?.preapproved,
      tags: create?.tags,
      expirySeconds: undefined,
    };
  },
});

const tailscaleTailnetKeyCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return tailnetKeyZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return tailnetKeyZodCodec.decode(result.data);
  },
};

// ─── API response schemas ────────────────────────────────────────────────────

const keyListResponseSchema = z.looseObject({
  keys: z.array(
    z.looseObject({
      id: z.string().trim(),
      description: z.string().trim(),
    }),
  ),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildCreateRequest(spec: z.infer<typeof tailnetKeySpecSchema>): {
  description: string;
  reusable: boolean;
  ephemeral: boolean;
  preapproved?: boolean;
  tags?: readonly string[];
  expirySeconds?: number;
} {
  const req: {
    description: string;
    reusable: boolean;
    ephemeral: boolean;
    preapproved?: boolean;
    tags?: readonly string[];
    expirySeconds?: number;
  } = {
    description: spec.description,
    reusable: spec.reusable,
    ephemeral: spec.ephemeral,
  };
  if (spec.preapproved !== undefined) req.preapproved = spec.preapproved;
  if (spec.tags !== undefined) req.tags = spec.tags;
  if (spec.expirySeconds !== undefined) req.expirySeconds = spec.expirySeconds;
  return req;
}

// ─── Resource implementation ─────────────────────────────────────────────────

export class TailnetKeyResource implements ResourcePort<
  typeof tailnetKeySpecSchema,
  typeof tailnetKeyStateSchema
> {
  readonly kind = "TailnetKey";
  readonly specSchema = tailnetKeySpecSchema;
  readonly stateSchema = tailnetKeyStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = tailscaleTailnetKeyCodec;

  readonly scopes: ResourceScopes = {
    tailnetId: { config: "tailnetId" },
  };

  constructor(
    private readonly client: TailscaleClient | undefined,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId(state: unknown): string {
    if (typeof state === "object" && state !== null && "id" in state) {
      const desc = Object.getOwnPropertyDescriptor(state, "id");
      if (desc !== undefined && typeof desc.value === "string") {
        return desc.value;
      }
    }
    throw new Error("Invalid state: missing id");
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = tailnetKeySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("tailscale", "read", parsed.error.issues);
    }
    const tailnet = this.resolvedScopes.get("tailnetId");

    // List all keys and find by description (our identity field).
    // Tailscale doesn't support looking up keys by description directly.
    const rawList = await requireClient(this.client).listKeys(tailnet);
    const listResult = keyListResponseSchema.safeParse(rawList);
    if (!listResult.success) return undefined;

    const match = listResult.data.keys.find(
      (k) => k.description === parsed.data.description,
    );
    if (match === undefined) return undefined;

    return requireClient(this.client).getKey(tailnet, match.id);
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = tailnetKeySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("tailscale", "create", parsed.error.issues);
    }
    const tailnet = this.resolvedScopes.get("tailnetId");
    return requireClient(this.client).createKey(
      tailnet,
      buildCreateRequest(parsed.data),
    );
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    // Tailscale keys don't support update — delete and recreate
    void id;
    const parsed = tailnetKeySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("tailscale", "update", parsed.error.issues);
    }
    const tailnet = this.resolvedScopes.get("tailnetId");
    return requireClient(this.client).createKey(
      tailnet,
      buildCreateRequest(parsed.data),
    );
  }
}
