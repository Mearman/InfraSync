/**
 * Canonical Zod schemas for the Terraform interoperability IR.
 *
 * These model the data that flows through the Terraform interop adapters.
 * Types are inferred from these schemas — no separate interface definitions.
 *
 * Parse only at adapter boundaries (raw JSON → TerraformIR).
 */
import * as z from "zod";

// ─── Document kinds ──────────────────────────────────────────────────────────

export const terraformDocumentKindSchema = z.enum([
  "desired_config",
  "planned_change",
  "observed_state",
]);

// ─── Source metadata ─────────────────────────────────────────────────────────

export const terraformSourceMetaSchema = z.object({
  system: z.literal("terraform"),
  format: z.enum(["tf_config_json", "tf_show_plan_json", "tf_show_state_json"]),
  terraformVersion: z.string().trim().optional(),
  formatVersion: z.string().trim().optional(),
});

// ─── Address model ───────────────────────────────────────────────────────────

export const terraformAddressPartsSchema = z.object({
  modulePath: z.array(z.string().trim()),
  mode: z.enum(["managed", "data"]),
  type: z.string().trim(),
  name: z.string().trim(),
  instanceKey: z.union([z.string().trim(), z.number()]).optional(),
});

// ─── Provider reference ──────────────────────────────────────────────────────

export const terraformProviderRefSchema = z.object({
  localName: z.string().trim(),
  fullName: z.string().trim().optional(),
  alias: z.string().trim().optional(),
});

// ─── Nested block ────────────────────────────────────────────────────────────

export const terraformNestedBlockSchema: z.ZodType<TerraformNestedBlock> =
  z.lazy(
    (): z.ZodObject<{
      label: z.ZodOptional<z.ZodString>;
      arguments: z.ZodRecord<z.ZodString, z.ZodUnknown>;
      nestedBlocks: z.ZodRecord<
        z.ZodString,
        z.ZodArray<z.ZodType<TerraformNestedBlock>>
      >;
    }> =>
      z.object({
        label: z.string().trim().optional(),
        arguments: z.record(z.string(), z.unknown()),
        nestedBlocks: z.record(z.string(), z.array(terraformNestedBlockSchema)),
      }),
  );

export interface TerraformNestedBlock {
  readonly label?: string | undefined;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly nestedBlocks: Readonly<
    Record<string, readonly TerraformNestedBlock[]>
  >;
}

// ─── Resource config ─────────────────────────────────────────────────────────

export const terraformResourceConfigSchema = z.object({
  arguments: z.record(z.string(), z.unknown()),
  nestedBlocks: z.record(z.string(), z.array(terraformNestedBlockSchema)),
  meta: z.object({
    dependsOn: z.array(z.string().trim()).optional(),
    count: z.unknown().optional(),
    forEach: z.unknown().optional(),
    provider: z.string().trim().optional(),
    lifecycle: z
      .object({
        createBeforeDestroy: z.boolean().optional(),
        preventDestroy: z.boolean().optional(),
        ignoreChanges: z.array(z.string().trim()).optional(),
        replaceTriggeredBy: z.array(z.string().trim()).optional(),
      })
      .optional(),
  }),
});

// ─── Resource state ──────────────────────────────────────────────────────────

export const terraformResourceStateSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  unknownMask: z.array(z.string().trim()).optional(),
  sensitiveMask: z.array(z.string().trim()).optional(),
});

// ─── Change actions ──────────────────────────────────────────────────────────

export const terraformChangeActionSchema = z.enum([
  "no-op",
  "create",
  "read",
  "update",
  "delete",
  "create-before-destroy",
  "destroy-before-create",
]);

// ─── Resource change ─────────────────────────────────────────────────────────

export const terraformResourceChangeSchema = z.object({
  address: z.string().trim(),
  previousAddress: z.string().trim().optional(),
  mode: z.enum(["managed", "data"]),
  type: z.string().trim(),
  name: z.string().trim(),
  instanceKey: z.union([z.string().trim(), z.number()]).optional(),
  providerName: z.string().trim(),
  change: z.object({
    actions: z.array(terraformChangeActionSchema).readonly(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    afterUnknown: z.unknown().optional(),
    replacePaths: z.array(z.unknown()).optional(),
    actionReason: z.string().trim().optional(),
    importing: z.object({ id: z.string().trim() }).optional(),
  }),
});

// ─── Resource in the TF-IR ───────────────────────────────────────────────────

export const terraformResourceIRSchema = z.object({
  address: z.string().trim().meta({ description: "Full Terraform address" }),
  addressParts: terraformAddressPartsSchema,
  provider: terraformProviderRefSchema,
  config: terraformResourceConfigSchema.optional(),
  state: terraformResourceStateSchema.optional(),
  change: terraformResourceChangeSchema.optional(),
  extensions: z.object({
    terraform: z
      .object({
        raw: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
});

// ─── Output ──────────────────────────────────────────────────────────────────

export const terraformOutputIRSchema = z.object({
  name: z.string().trim(),
  value: z.unknown().optional(),
  sensitive: z.boolean(),
  description: z.string().trim().optional(),
});

// ─── Check ───────────────────────────────────────────────────────────────────

export const terraformCheckStatusSchema = z.enum([
  "pass",
  "fail",
  "error",
  "unknown",
]);

export const terraformCheckIRSchema = z.object({
  address: z.string().trim(),
  status: terraformCheckStatusSchema,
  message: z.string().trim().optional(),
});

// ─── Top-level document ──────────────────────────────────────────────────────

export const terraformIRSchema = z.object({
  irVersion: z.literal("1.0"),
  kind: terraformDocumentKindSchema,
  source: terraformSourceMetaSchema,
  resources: z.array(terraformResourceIRSchema).readonly(),
  outputs: z.array(terraformOutputIRSchema).readonly(),
  checks: z.array(terraformCheckIRSchema).readonly(),
  extensions: z.object({
    terraform: z
      .object({
        raw: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TerraformDocumentKind = z.infer<typeof terraformDocumentKindSchema>;
export type TerraformSourceMeta = z.infer<typeof terraformSourceMetaSchema>;
export type TerraformAddressParts = z.infer<typeof terraformAddressPartsSchema>;
export type TerraformProviderRef = z.infer<typeof terraformProviderRefSchema>;
export type TerraformResourceConfig = z.infer<
  typeof terraformResourceConfigSchema
>;
export type TerraformResourceState = z.infer<
  typeof terraformResourceStateSchema
>;
export type TerraformChangeAction = z.infer<typeof terraformChangeActionSchema>;
export type TerraformResourceChange = z.infer<
  typeof terraformResourceChangeSchema
>;
export type TerraformResourceIR = z.infer<typeof terraformResourceIRSchema>;
export type TerraformOutputIR = z.infer<typeof terraformOutputIRSchema>;
export type TerraformCheckStatus = z.infer<typeof terraformCheckStatusSchema>;
export type TerraformCheckIR = z.infer<typeof terraformCheckIRSchema>;
export type TerraformIR = z.infer<typeof terraformIRSchema>;

// ─── JSON Schema exports ─────────────────────────────────────────────────────

export const terraformIRJsonSchema = z.toJSONSchema(terraformIRSchema);

// ─── Address parser ──────────────────────────────────────────────────────────

/**
 * Parse a Terraform resource address string into its component parts.
 *
 * Supports:
 *   - `aws_instance.web`
 *   - `module.vpc.aws_subnet.public`
 *   - `aws_instance.web[0]`
 *   - `module.vpc.aws_instance.web["key"]`
 *   - `data.aws_ami.ubuntu`
 */
export function parseTerraformAddress(address: string): TerraformAddressParts {
  const instanceKeyMatch = /\[(.+)\]\s*$/.exec(address);
  let instanceKey: string | number | undefined;
  let addressWithoutKey = address;

  if (instanceKeyMatch !== null) {
    const rawMatch = instanceKeyMatch[1];
    if (rawMatch === undefined) {
      return {
        modulePath: [],
        mode: "managed",
        type: "",
        name: "",
      };
    }
    const raw = rawMatch.trim();
    instanceKey =
      raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : Number(raw);
    addressWithoutKey = address.slice(0, address.lastIndexOf("[")).trim();
  }

  const segments = addressWithoutKey.split(".");
  const mode: "data" | "managed" = segments[0] === "data" ? "data" : "managed";

  if (mode === "data") {
    const nonDataSegments = segments.slice(1);
    const modulePath: string[] = [];
    let remaining = nonDataSegments;

    while (remaining.length > 2 && remaining[0] !== undefined) {
      if (remaining.length >= 2 && remaining[1] === "data") {
        modulePath.push(remaining[0]);
        remaining = remaining.slice(2);
      } else {
        break;
      }
    }

    return {
      modulePath,
      mode: "data",
      type: remaining[0] ?? "",
      name: remaining[1] ?? "",
      instanceKey,
    };
  }

  // managed: TYPE.NAME or module.X.TYPE.NAME
  const modulePath: string[] = [];
  let remaining = segments;

  while (remaining.length > 2 && remaining[0] !== undefined) {
    if (remaining[0] === "module" && remaining.length > 2) {
      const moduleSegment = remaining[1];
      if (moduleSegment === undefined) break;
      modulePath.push(moduleSegment);
      remaining = remaining.slice(2);
    } else {
      break;
    }
  }

  return {
    modulePath,
    mode: "managed",
    type: remaining[0] ?? "",
    name: remaining[1] ?? "",
    instanceKey,
  };
}
