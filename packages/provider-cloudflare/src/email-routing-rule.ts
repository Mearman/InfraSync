import Cloudflare from "cloudflare";
import type {
  RuleCreateParams,
  RuleUpdateParams,
} from "cloudflare/resources/email-routing/rules/rules.js";
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
import { getStateId } from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface EmailRoutingRuleRefs {
  readonly id: RefToken;
  readonly name: RefToken;
  readonly enabled: RefToken;
}

export const buildEmailRoutingRuleRefs: RefBuilder<EmailRoutingRuleRefs> = (
  resourceName,
) => ({
  id: new RefToken(resourceName, "id"),
  name: new RefToken(resourceName, "name"),
  enabled: new RefToken(resourceName, "enabled"),
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Action schema — what to do with a matched email.
 *
 * `forward`: send to destination addresses.
 * `drop`: discard the email.
 * `worker`: invoke a Worker script.
 */
const actionSchema = z.object({
  type: z.enum(["forward", "drop", "worker"]),
  value: z.array(z.string().trim()).optional(),
});

/**
 * Matcher schema — criteria for matching an email.
 *
 * `literal`: match a specific address (e.g. "user@example.com").
 * `all`: match all emails.
 */
const matcherSchema = z.object({
  type: z.enum(["all", "literal"]),
  field: z.enum(["to"]).optional(),
  value: z.string().trim().optional(),
});

export const emailRoutingRuleSpecSchema = z.object({
  kind: z.literal("EmailRoutingRule"),
  /** Zone name the email routing rule belongs to */
  zoneName: z.string().trim().min(1),
  /** Rule name (identity field within a zone) */
  name: z.string().trim().min(1).optional(),
  /** Actions to apply to matched emails */
  actions: z.array(actionSchema),
  /** Matchers for selecting which emails to route */
  matchers: z.array(matcherSchema),
  /** Whether the rule is enabled */
  enabled: z.boolean().optional(),
  /** Priority — lower numbers match first */
  priority: z.int().min(0).optional(),
});

export type EmailRoutingRuleSpec = z.infer<typeof emailRoutingRuleSpecSchema>;

const resolvedSpecSchema = z.object({
  kind: z.literal("EmailRoutingRule"),
  zoneName: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  actions: z.array(actionSchema),
  matchers: z.array(matcherSchema),
  enabled: z.boolean().optional(),
  priority: z.int().min(0).optional(),
});

const emailRoutingRuleStateSchema = z
  .looseObject({
    id: z.string().trim(),
    name: z.string().trim().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().optional(),
    actions: z
      .array(
        z.looseObject({
          type: z.string().trim(),
          value: z.array(z.string().trim()).optional(),
        }),
      )
      .optional(),
    matchers: z
      .array(
        z.looseObject({
          type: z.string().trim(),
          field: z.string().trim().optional(),
          value: z.string().trim().optional(),
        }),
      )
      .optional(),
  })
  .brand<"CloudflareEmailRoutingRuleState">()
  .readonly();

const apiResponseSchema = z.looseObject({
  id: z.string().trim(),
  name: z.string().trim().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().optional(),
  actions: z
    .array(
      z.looseObject({
        type: z.string().trim(),
        value: z.array(z.string().trim()).optional(),
      }),
    )
    .optional(),
  matchers: z
    .array(
      z.looseObject({
        type: z.string().trim(),
        field: z.string().trim().optional(),
        value: z.string().trim().optional(),
      }),
    )
    .optional(),
});

const identitySchema = emailRoutingRuleSpecSchema.pick({
  zoneName: true,
  name: true,
});

const desiredStateSchema = emailRoutingRuleSpecSchema.pick({
  actions: true,
  matchers: true,
  enabled: true,
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

// ─── Rule matching ──────────────────────────────────────────────────────────

/** Minimal schema for name-based rule matching. */
const nameMatchSchema = z.object({
  name: z.string().trim(),
  id: z.string().trim().optional(),
});

/** Minimal schema for matcher-value-based rule matching. */
const matcherRuleSchema = z.object({
  matchers: z.array(
    z.object({ type: z.string().trim(), value: z.string().trim().optional() }),
  ),
});

/**
 * Find an email routing rule by name or by first matcher's value.
 *
 * Uses Zod schemas to narrow API results instead of Object.getOwnPropertyDescriptor.
 */
function matchRule(
  rules: readonly unknown[],
  name: string | undefined,
  matchers: readonly { type: string; value?: string | undefined }[],
): unknown {
  return rules.find((rule) => {
    // Match by name first
    if (name !== undefined) {
      const result = nameMatchSchema.safeParse(rule);
      if (result.success && result.data.name === name) {
        return true;
      }
    }

    // Match by first matcher's value (the email address being routed)
    if (name === undefined) {
      const result = matcherRuleSchema.safeParse(rule);
      if (
        result.success &&
        result.data.matchers.length > 0 &&
        matchers.length > 0
      ) {
        const ruleFirst = result.data.matchers[0];
        const specFirst = matchers[0];
        if (ruleFirst !== undefined && specFirst !== undefined) {
          return (
            ruleFirst.type === specFirst.type &&
            ruleFirst.value === specFirst.value
          );
        }
      }
    }

    return false;
  });
}

// ─── Codec schemas ───────────────────────────────────────────────────────────

const codecInputSchema = z.object({
  kind: z.literal("EmailRoutingRule"),
  name: z.string().trim().min(1).optional(),
  actions: z.array(actionSchema),
  matchers: z.array(matcherSchema),
  enabled: z.boolean().optional(),
  priority: z.int().min(0).optional(),
});

const EMAIL_ROUTING_RULE_KIND = "EmailRoutingRule" as const;

const codecOutputSchema = z.looseObject({
  name: z.string().trim().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().optional(),
  actions: z
    .array(
      z.looseObject({
        type: z.string().trim(),
        value: z.array(z.string().trim()).optional(),
      }),
    )
    .optional(),
  matchers: z
    .array(
      z.looseObject({
        type: z.string().trim(),
        field: z.string().trim().optional(),
        value: z.string().trim().optional(),
      }),
    )
    .optional(),
});

const emailRoutingRuleZodCodec = z.codec(codecInputSchema, codecOutputSchema, {
  decode: (spec) => ({
    name: spec.name,
    enabled: spec.enabled,
    priority: spec.priority,
    actions: spec.actions.map((a) => ({ type: a.type, value: a.value })),
    matchers: spec.matchers.map((m) => ({
      type: m.type,
      field: m.field,
      value: m.value,
    })),
  }),
  encode: (state) => ({
    kind: EMAIL_ROUTING_RULE_KIND,
    name: state.name,
    enabled: state.enabled,
    priority:
      state.priority !== undefined
        ? z.int().min(0).parse(state.priority)
        : undefined,
    actions:
      state.actions !== undefined
        ? state.actions.map((a) => ({
            type: z.enum(["forward", "drop", "worker"]).parse(a.type),
            value: a.value,
          }))
        : [],
    matchers:
      state.matchers !== undefined
        ? state.matchers.map((m) => ({
            type: z.enum(["all", "literal"]).parse(m.type),
            field:
              m.field !== undefined ? z.enum(["to"]).parse(m.field) : undefined,
            value: m.value,
          }))
        : [],
  }),
});

const cloudflareEmailRoutingRuleCodec: ResourceCodec = {
  encode(state: unknown): unknown {
    const result = codecOutputSchema.safeParse(state);
    if (!result.success) return state;
    return emailRoutingRuleZodCodec.encode(result.data);
  },
  decode(spec: unknown): unknown {
    const result = codecInputSchema.safeParse(spec);
    if (!result.success) return spec;
    return emailRoutingRuleZodCodec.decode(result.data);
  },
};

// ─── Resource implementation ─────────────────────────────────────────────────

export class EmailRoutingRuleResource implements ResourcePort<
  typeof emailRoutingRuleSpecSchema,
  typeof emailRoutingRuleStateSchema
> {
  readonly kind = "EmailRoutingRule";
  readonly specSchema = emailRoutingRuleSpecSchema;
  readonly stateSchema = emailRoutingRuleStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;
  readonly codec = cloudflareEmailRoutingRuleCodec;

  readonly scopes: ResourceScopes = {
    accountId: { config: "accountId" },
  };

  constructor(
    private readonly client: Cloudflare,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId = getStateId;

  async read(spec: unknown): Promise<unknown> {
    const parsed = emailRoutingRuleSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "read", parsed.error.issues);
    }

    // Look up zone_id from zone name
    const zones = await this.client.zones.list({
      name: parsed.data.zoneName,
      account: { id: this.resolvedScopes.get("accountId") },
    });
    const zone = zones.result[0];
    if (zone === undefined) return undefined;

    const rules = await this.client.emailRouting.rules.list({
      zone_id: zone.id,
    });

    const found = matchRule(
      rules.result,
      parsed.data.name,
      parsed.data.matchers,
    );
    if (found === undefined) return undefined;
    return validateApiResponse(found, "read");
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "create", parsed.error.issues);
    }

    const zones = await this.client.zones.list({
      name: parsed.data.zoneName,
      account: { id: this.resolvedScopes.get("accountId") },
    });
    const zone = zones.result[0];
    if (zone === undefined) {
      throw new ProviderApiError("cloudflare", "create", [
        {
          path: ["zoneName"],
          message: `Zone "${parsed.data.zoneName}" not found`,
        },
      ]);
    }

    const params: RuleCreateParams = {
      zone_id: zone.id,
      actions: parsed.data.actions.map((a) => {
        const action: {
          type: "forward" | "drop" | "worker";
          value?: string[];
        } = {
          type: a.type,
        };
        if (a.value !== undefined) action.value = a.value;
        return action;
      }),
      matchers: parsed.data.matchers.map((m) => {
        const matcher: {
          type: "all" | "literal";
          field?: "to";
          value?: string;
        } = {
          type: m.type,
        };
        if (m.field !== undefined) matcher.field = m.field;
        if (m.value !== undefined) matcher.value = m.value;
        return matcher;
      }),
    };
    if (parsed.data.name !== undefined) params.name = parsed.data.name;
    if (parsed.data.enabled !== undefined) params.enabled = parsed.data.enabled;
    if (parsed.data.priority !== undefined)
      params.priority = parsed.data.priority;

    const response = await this.client.emailRouting.rules.create(params);

    return validateApiResponse(response, "create");
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = resolvedSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("cloudflare", "update", parsed.error.issues);
    }

    const zones = await this.client.zones.list({
      name: parsed.data.zoneName,
      account: { id: this.resolvedScopes.get("accountId") },
    });
    const zone = zones.result[0];
    if (zone === undefined) {
      throw new ProviderApiError("cloudflare", "update", [
        {
          path: ["zoneName"],
          message: `Zone "${parsed.data.zoneName}" not found`,
        },
      ]);
    }

    const params: RuleUpdateParams = {
      zone_id: zone.id,
      actions: parsed.data.actions.map((a) => {
        const action: {
          type: "forward" | "drop" | "worker";
          value?: string[];
        } = {
          type: a.type,
        };
        if (a.value !== undefined) action.value = a.value;
        return action;
      }),
      matchers: parsed.data.matchers.map((m) => {
        const matcher: {
          type: "all" | "literal";
          field?: "to";
          value?: string;
        } = {
          type: m.type,
        };
        if (m.field !== undefined) matcher.field = m.field;
        if (m.value !== undefined) matcher.value = m.value;
        return matcher;
      }),
    };
    if (parsed.data.name !== undefined) params.name = parsed.data.name;
    if (parsed.data.enabled !== undefined) params.enabled = parsed.data.enabled;
    if (parsed.data.priority !== undefined)
      params.priority = parsed.data.priority;

    const response = await this.client.emailRouting.rules.update(id, params);

    return validateApiResponse(response, "update");
  }
}
