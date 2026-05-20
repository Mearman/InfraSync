import Cloudflare from "cloudflare";
import type {
  ResourcePort,
  ResourceCodec,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import * as z from "zod";
import { ProviderApiError } from "@infrasync-org/core/errors";
import { getStateId, findByPattern } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface WorkerRouteRefs {
  readonly id: RefToken;
  readonly pattern: RefToken;
  readonly script: RefToken;
}

export const buildWorkerRouteRefs: RefBuilder<WorkerRouteRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  pattern: new RefToken(resourceName, "pattern"),
  script: new RefToken(resourceName, "script"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const workerRouteSpecSchema = z.object({
  kind: z.literal("WorkerRoute"),
  /** URL pattern to match (identity field, e.g. "example.com/*") */
  pattern: z.string().trim().min(1),
  /** Name of the Worker script to invoke when the route matches */
  script: z.string().trim().min(1),
  /**
   * Zone name — used to look up the zone_id for API calls.
   * Derived from the pattern if not provided.
   */
  zoneName: z.string().trim().optional(),
});

export type WorkerRouteSpec = z.infer<typeof workerRouteSpecSchema>;

const resolvedSpecSchema = z.object({
  kind: z.literal("WorkerRoute"),
  pattern: z.string().trim().min(1),
  script: z.string().trim().min(1),
  zoneName: z.string().trim().optional(),
});

const workerRouteStateSchema = z
  .looseObject({
    id: z.string().trim(),
    pattern: z.string().trim(),
    script: z.string().trim().optional(),
  })
  .brand<"CloudflareWorkerRouteState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  pattern: z.string().trim(),
  script: z.string().trim().optional(),
});

const identitySchema = workerRouteSpecSchema.pick({ pattern: true });

const desiredStateSchema = workerRouteSpecSchema.pick({
  script: true,
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
 * Extract zone name from a route pattern.
 *
 * Patterns are like "example.com/*", "api.example.com/users/*", "*.example.com/*".
 * We extract the base domain (last two segments of the first hostname part).
 */
function extractZoneFromPattern(pattern: string): string {
  // Strip the path part after the hostname
  const slashIdx = pattern.indexOf("/");
  const hostPart = slashIdx >= 0 ? pattern.slice(0, slashIdx) : pattern;

  // Remove leading wildcard and dot
  const cleaned = hostPart.replace(/^\*\./, "");
  // Take last two segments for the zone
  const parts = cleaned.split(".");
  return parts.slice(-2).join(".");
}

// ─── Codec schemas ───────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("WorkerRoute"),
  pattern: z.string().trim().min(1),
  script: z.string().trim().optional(),
  zoneName: z.string().trim().optional(),
});

const WORKER_ROUTE_KIND = "WorkerRoute" as const;

const codecOutputSchema = z.looseObject({
  pattern: z.string().trim(),
  script: z.string().trim().optional(),
});

const workerRouteZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    pattern: spec.pattern,
    script: spec.script,
  }),
  encode: (state) => ({
    kind: WORKER_ROUTE_KIND,
    pattern: state.pattern,
    script: state.script,
  }),
});

const cloudflareWorkerRouteCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return workerRouteZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return workerRouteZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class WorkerRouteResource implements ResourcePort<
  typeof workerRouteSpecSchema,
  typeof workerRouteStateSchema
> {
  readonly kind = "WorkerRoute";
  readonly specSchema = workerRouteSpecSchema;
  readonly stateSchema = workerRouteStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = cloudflareWorkerRouteCodec;

  readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  constructor(
    private readonly client: Cloudflare,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = workerRouteSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    const zoneName =
      parsed.data.zoneName ?? extractZoneFromPattern(parsed.data.pattern);

    const zones = await this.client.zones.list({
      name: zoneName,
      account: { id: this.resolvedScopes.get("accountId") },
    });
    const zone = zones.result[0];
    if (zone === undefined) return undefined;

    const response = await this.client.workers.routes.list({
      zone_id: zone.id,
    });

    const match = findByPattern(response.result, parsed.data.pattern);
    if (match === undefined) return undefined;
    return validateApiResponse(match, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }

    const zoneName =
      parsed.data.zoneName ?? extractZoneFromPattern(parsed.data.pattern);

    const zones = await this.client.zones.list({
      name: zoneName,
      account: { id: this.resolvedScopes.get("accountId") },
    });
    const zone = zones.result[0];
    if (zone === undefined) {
      throw new ProviderApiError("cloudflare", "create", [
        {
          path: ["pattern"],
          message: `Zone "${zoneName}" not found for pattern "${parsed.data.pattern}"`,
        },
      ]);
    }

    const response = await this.client.workers.routes.create({
      zone_id: zone.id,
      pattern: parsed.data.pattern,
      script: parsed.data.script,
    });

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }

    const zoneName =
      parsed.data.zoneName ?? extractZoneFromPattern(parsed.data.pattern);

    const zones = await this.client.zones.list({
      name: zoneName,
      account: { id: this.resolvedScopes.get("accountId") },
    });
    const zone = zones.result[0];
    if (zone === undefined) {
      throw new ProviderApiError("cloudflare", "update", [
        {
          path: ["pattern"],
          message: `Zone "${zoneName}" not found for pattern "${parsed.data.pattern}"`,
        },
      ]);
    }

    const response = await this.client.workers.routes.update(id, {
      zone_id: zone.id,
      pattern: parsed.data.pattern,
      script: parsed.data.script,
    });

    return validateApiResponse(response, "update");
  }
}
