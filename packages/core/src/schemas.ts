/**
 * Canonical Zod schemas for InfraSync IR.
 *
 * Single source of truth: types are inferred from these schemas.
 * JSON Schema representations are exported via `z.toJSONSchema()`.
 *
 * Parse only at serialisation boundaries (file loads, CLI input).
 * Internal code uses inferred types directly — no redundant parsing.
 */
import * as z from "zod";

// ─── Refs and secrets ────────────────────────────────────────────────────────

export const refTokenIRSchema = z
  .object({
    $ref: z.object({
      resource: z.string().trim(),
      path: z.string().trim(),
    }),
  })
  .meta({
    description:
      "A symbolic reference from one resource's spec to another resource's state",
  });

export const refBindingIRSchema = z
  .object({
    specPath: z.string().trim().meta({
      description:
        'Dot-notation path within the resource spec (e.g. "value", "policy.Resource")',
    }),
    targetResource: z
      .string()
      .trim()
      .meta({ description: "The resource name this ref targets" }),
    statePath: z.string().trim().meta({
      description:
        'Dot-notation path within the target resource\'s state (e.g. "websiteEndpoint")',
    }),
  })
  .meta({
    description:
      "A binding between a spec field path and the state field it references",
  });

export const secretSourceIRSchema = z
  .object({
    $secret: z.object({
      kind: z.literal("env"),
      name: z.string().trim(),
    }),
  })
  .meta({
    description:
      "A serialisable descriptor for a secret value — instructions for where to find it at execution time",
  });

// ─── Providers ───────────────────────────────────────────────────────────────

export const providerInstanceIRSchema = z
  .object({
    key: z.string().trim().meta({
      description:
        'Unique instance key within the configuration (e.g. "awsProd", "cfCompany")',
    }),
    adapterName: z.string().trim().meta({
      description:
        'The adapter name this instance uses (e.g. "cloudflare", "aws")',
    }),
    config: z.record(z.string(), z.unknown()).meta({
      description:
        "Raw config object — may contain SecretSourceIR values to be resolved at execution time",
    }),
  })
  .meta({
    description: "A provider instance as it appears in compiled InfraIR",
  });

// ─── Resources ───────────────────────────────────────────────────────────────

export const resourceIRSchema = z
  .object({
    name: z.string().trim().meta({
      description: "Unique name within the configuration — the DAG node key",
    }),
    provider: z.string().trim().meta({
      description: "Provider instance key this resource is routed to",
    }),
    kind: z.string().trim().meta({
      description:
        'Resource kind within that provider (e.g. "DnsRecord", "S3Bucket")',
    }),
    mode: z.enum(["manage", "read"]).meta({
      description: "Whether the engine manages this resource or just reads it",
    }),
    spec: z.record(z.string(), z.unknown()).meta({
      description: "Raw spec — may contain RefTokenIR or SecretSourceIR values",
    }),
    dependsOn: z
      .array(z.string().trim())
      .readonly()
      .meta({ description: "Explicit dependency edges by resource name" }),
    refBindings: z.array(refBindingIRSchema).readonly().meta({
      description:
        "Symbolic ref bindings extracted from the spec at compile time",
    }),
  })
  .meta({ description: "A single resource as it appears in compiled InfraIR" });

// ─── Top-level ───────────────────────────────────────────────────────────────

export const infraIRSchema = z
  .object({
    name: z.string().trim().meta({ description: "Configuration name" }),
    providers: z.array(providerInstanceIRSchema).readonly(),
    resources: z.array(resourceIRSchema).readonly(),
  })
  .meta({
    description:
      "The canonical, flat intermediate representation the engine consumes",
  });

// ─── Inferred types ──────────────────────────────────────────────────────────

export type RefTokenIR = z.infer<typeof refTokenIRSchema>;
export type RefBindingIR = z.infer<typeof refBindingIRSchema>;
export type SecretSourceIR = z.infer<typeof secretSourceIRSchema>;
export type ProviderInstanceIR = z.infer<typeof providerInstanceIRSchema>;
export type ResourceIR = z.infer<typeof resourceIRSchema>;
export type InfraIR = z.infer<typeof infraIRSchema>;

// ─── JSON Schema exports ─────────────────────────────────────────────────────

export const infraIRJsonSchema = z.toJSONSchema(infraIRSchema);
