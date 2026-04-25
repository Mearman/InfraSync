/**
 * Bridge: TerraformIR → InfraIR
 *
 * Converts the analysis lane's TerraformIR (produced by TF-Show import)
 * into InfraSync's canonical InfraIR, enabling migration from Terraform
 * state/plan inspection to InfraSync management.
 *
 * This is the missing piece that closes the analysis lane — you can now:
 *   1. `infrasync import terraform-state --file state.json --out terraform-ir.json`
 *   2. Convert TerraformIR → InfraIR (this module)
 *   3. Start managing infrastructure with InfraSync
 *
 * Fidelity reporting classifies every translation as lossless/lossy/unsupported.
 */
import { FidelityReportBuilder } from "@infrasync/core-fidelity/fidelity";
import type { AdapterResult } from "@infrasync/core-fidelity/fidelity";
import type {
  InfraIR,
  ProviderInstanceIR,
  RefBindingIR,
  RefTokenIR,
  ResourceIR,
} from "@infrasync/core/types";
import { infraIRSchema } from "@infrasync/core/schemas";
import type {
  TerraformIR,
  TerraformResourceIR,
  TerraformResourceConfig,
  TerraformNestedBlock,
} from "@infrasync/core-ir/schemas";

// ─── Provider mapping ────────────────────────────────────────────────────────

/**
 * Maps Terraform provider source strings to InfraSync adapter names.
 *
 * Keys are lower-cased substrings matched against the TF provider source.
 * For example, `"registry.terraform.io/cloudflare/cloudflare"` matches `"cloudflare"`.
 */
const PROVIDER_ADAPTER_MAP: ReadonlyMap<string, string> = new Map([
  ["cloudflare", "cloudflare"],
  ["aws", "aws"],
  ["google", "google"],
  ["github", "github"],
  ["vercel", "vercel"],
  ["azurerm", "azure"],
  ["supabase", "supabase"],
]);

/**
 * Result of resolving a Terraform provider reference.
 */
interface ResolvedProvider {
  readonly instanceKey: string;
  readonly adapterName: string;
  readonly providerSource: string;
}

/**
 * Resolve a Terraform provider reference to an InfraSync adapter name + instance key.
 *
 * Uses the provider local name from TerraformIR (e.g. `"cloudflare"` or
 * `"registry.terraform.io/cloudflare/cloudflare"`) to find the adapter.
 */
function resolveProvider(
  providerLocalName: string,
  reporter: FidelityReportBuilder,
): ResolvedProvider {
  // Normalise: extract the provider type from a full source path
  // e.g. "registry.terraform.io/cloudflare/cloudflare" → "cloudflare"
  const normalised = providerLocalName.toLowerCase();
  const segments = normalised.split("/");
  const providerType = segments[segments.length - 1] ?? normalised;

  for (const [key, adapterName] of PROVIDER_ADAPTER_MAP) {
    if (providerType.includes(key)) {
      return {
        instanceKey: adapterName,
        adapterName,
        providerSource: providerLocalName,
      };
    }
  }

  // Unknown provider — use the provider type as adapter name
  reporter.addIssue({
    path: `provider.${providerLocalName}`,
    class: "lossy",
    message: `Unknown Terraform provider "${providerLocalName}" — using "${providerType}" as adapter name`,
    action: "approximated",
  });

  return {
    instanceKey: providerType,
    adapterName: providerType,
    providerSource: providerLocalName,
  };
}

// ─── Nested block flattening ─────────────────────────────────────────────────

/**
 * Flatten a Terraform nested block structure into a plain object.
 *
 * Terraform nested blocks are arrays of objects. For InfraSync we
 * convert single-element blocks to plain objects and multi-element
 * blocks to arrays.
 */
function flattenNestedBlocks(
  blocks: readonly TerraformNestedBlock[],
  reporter: FidelityReportBuilder,
  path: string,
): unknown {
  if (blocks.length === 0) return [];
  if (blocks.length === 1) {
    const block = blocks[0];
    if (block === undefined) return [];
    return flattenBlock(block, reporter, path);
  }

  // Multi-element block — preserve as array
  return blocks.map((block, index) =>
    flattenBlock(block, reporter, `${path}[${String(index)}]`),
  );
}

function flattenBlock(
  block: TerraformNestedBlock,
  reporter: FidelityReportBuilder,
  path: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(block.arguments)) {
    result[key] = value;
  }

  for (const [blockType, nestedBlocks] of Object.entries(block.nestedBlocks)) {
    const nestedPath = path === "" ? blockType : `${path}.${blockType}`;
    result[blockType] = flattenNestedBlocks(nestedBlocks, reporter, nestedPath);
  }

  // Block labels are lost — Terraform uses them for identity but InfraSync
  // uses resource names, so labels are informational only.
  if (block.label !== undefined) {
    reporter.addIssue({
      path: `${path}.label`,
      class: "lossy",
      message: `Nested block label "${block.label}" dropped — InfraSync uses resource names for identity`,
      action: "dropped",
    });
  }

  return result;
}

// ─── Reference detection ─────────────────────────────────────────────────────

/**
 * Pattern matching Terraform interpolation references: `${type.name.path}`
 */
const TF_REF_PATTERN = /\$\{([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+)\}/g;

interface DetectedRef {
  readonly specPath: string;
  readonly targetResource: string;
  readonly statePath: string;
  readonly token: RefTokenIR;
}

/**
 * Walk a spec object and detect Terraform interpolation references.
 * Converts `${type.name.path}` patterns into RefTokenIR + RefBindingIR.
 */
function detectRefs(
  spec: Record<string, unknown>,
  reporter: FidelityReportBuilder,
  resourcePath: string,
): {
  readonly spec: Record<string, unknown>;
  readonly refs: readonly DetectedRef[];
} {
  const refs: DetectedRef[] = [];
  const processed = walkAndConvertRefs(spec, refs, reporter, resourcePath);
  return { spec: processed, refs };
}

function walkAndConvertRefs(
  obj: Record<string, unknown>,
  refs: DetectedRef[],
  reporter: FidelityReportBuilder,
  basePath: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = basePath === "" ? key : `${basePath}.${key}`;
    result[key] = convertValue(value, refs, reporter, currentPath);
  }

  return result;
}

function convertValue(
  value: unknown,
  refs: DetectedRef[],
  reporter: FidelityReportBuilder,
  path: string,
): unknown {
  if (typeof value === "string") {
    return convertStringRefs(value, refs, reporter, path);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      convertValue(item, refs, reporter, `${path}[${String(index)}]`),
    );
  }

  if (typeof value === "object" && value !== null) {
    // Already a RefTokenIR or SecretSourceIR — pass through
    if ("$ref" in value) return value;
    if ("$secret" in value) return value;

    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      record[k] = convertValue(v, refs, reporter, `${path}.${k}`);
    }
    return record;
  }

  return value;
}

function convertStringRefs(
  value: string,
  refs: DetectedRef[],
  reporter: FidelityReportBuilder,
  path: string,
): unknown {
  // Check for pure reference (entire string is one interpolation)
  const pureMatch = /^\$\{([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+)\}$/.exec(
    value,
  );

  if (pureMatch?.[1] !== undefined) {
    const ref = parseRefExpression(pureMatch[1]);
    if (ref !== undefined) {
      const token: RefTokenIR = {
        $ref: { resource: ref.targetResource, path: ref.statePath },
      };
      refs.push({
        specPath: path,
        targetResource: ref.targetResource,
        statePath: ref.statePath,
        token,
      });
      return token;
    }
  }

  // Check for references within template strings (mixed content)
  const allRefs: { readonly match: string; readonly expr: string }[] = [];
  let match: RegExpExecArray | null;

  TF_REF_PATTERN.lastIndex = 0;
  while ((match = TF_REF_PATTERN.exec(value)) !== null) {
    if (match[1] !== undefined) {
      allRefs.push({ match: match[0], expr: match[1] });
    }
  }

  if (allRefs.length === 0) return value;

  // Template string with embedded refs — report as lossy since InfraSync
  // doesn't natively support Terraform template syntax
  reporter.addIssue({
    path,
    class: "lossy",
    message: `Template string "${value}" contains Terraform interpolation — preserved as literal`,
    action: "approximated",
  });

  return value;
}

interface ParsedRef {
  readonly targetResource: string;
  readonly statePath: string;
}

function parseRefExpression(expr: string): ParsedRef | undefined {
  // e.g. "cloudflare_zone.zone.zone_id" → resource="cloudflare_zone.zone", path="zone_id"
  // e.g. "aws_s3_bucket.bucket.arn" → resource="aws_s3_bucket.bucket", path="arn"
  const parts = expr.split(".");
  if (parts.length < 3) return undefined;

  // First two parts are type.name (the resource address)
  const typePart = parts[0];
  const namePart = parts[1];
  if (typePart === undefined || namePart === undefined) return undefined;
  const resourceAddr = `${typePart}.${namePart}`;
  const statePath = parts.slice(2).join(".");

  return { targetResource: resourceAddr, statePath };
}

// ─── Resource name derivation ────────────────────────────────────────────────

/**
 * Derive an InfraSync resource name from a Terraform resource.
 *
 * Uses the Terraform resource name (e.g. `"www"` from `cloudflare_record.www`).
 * For data sources, prefixes with `"data_"` to avoid collisions with managed resources.
 */
function deriveResourceName(tfResource: TerraformResourceIR): string {
  const baseName = tfResource.addressParts.name;
  return tfResource.addressParts.mode === "data"
    ? `data_${baseName}`
    : baseName;
}

/**
 * Derive an InfraSync resource kind from a Terraform resource type.
 *
 * Converts snake_case Terraform types to PascalCase InfraSync kinds.
 * e.g. `cloudflare_record` → `CloudflareRecord`
 */
function deriveResourceKind(tfType: string): string {
  return tfType
    .split("_")
    .map((segment) =>
      segment.length > 0
        ? segment.charAt(0).toUpperCase() + segment.slice(1)
        : segment,
    )
    .join("");
}

// ─── Config flattening ───────────────────────────────────────────────────────

/**
 * Flatten a TerraformResourceConfig into a flat InfraSync spec record.
 */
function flattenConfig(
  config: TerraformResourceConfig,
  reporter: FidelityReportBuilder,
  resourcePath: string,
): Record<string, unknown> {
  const spec: Record<string, unknown> = {};

  // Copy arguments directly
  for (const [key, value] of Object.entries(config.arguments)) {
    spec[key] = value;
  }

  // Flatten nested blocks
  for (const [blockType, blocks] of Object.entries(config.nestedBlocks)) {
    const blockPath =
      resourcePath === "" ? blockType : `${resourcePath}.${blockType}`;
    spec[blockType] = flattenNestedBlocks(blocks, reporter, blockPath);
  }

  // Report meta fields that don't map to InfraSync
  if (config.meta.lifecycle !== undefined) {
    reporter.addIssue({
      path: `${resourcePath}.lifecycle`,
      class: "lossy",
      message: "Terraform lifecycle meta-argument not modelled in InfraSync IR",
      action: "dropped",
    });
  }

  return spec;
}

// ─── State value extraction ──────────────────────────────────────────────────

/**
 * Extract the state values from a TerraformResourceIR as a flat record.
 */
function extractStateValues(
  tfResource: TerraformResourceIR,
): Record<string, unknown> {
  if (tfResource.state === undefined) return {};
  return tfResource.state.values;
}

// ─── Main converter ──────────────────────────────────────────────────────────

export interface ConvertToInfraIROptions {
  /** Configuration name for the generated InfraIR */
  readonly name?: string;
}

/**
 * Convert a TerraformIR document (from TF-Show import) into an InfraIR document.
 *
 * This bridges the analysis lane into the InfraSync management pipeline.
 * Every provider and resource is mapped with fidelity tracking.
 *
 * @param terraformIR - The TerraformIR document to convert
 * @param options - Conversion options
 * @returns AdapterResult containing the InfraIR document and fidelity report
 */
export function convertToInfraIR(
  terraformIR: TerraformIR,
  options: ConvertToInfraIROptions = {},
): AdapterResult<InfraIR> {
  const reporter = new FidelityReportBuilder();

  // Track unique providers
  const providerMap = new Map<string, ResolvedProvider>();
  const resources: ResourceIR[] = [];

  // Build a name → index map for deduplication
  const nameCounts = new Map<string, number>();

  for (const tfResource of terraformIR.resources) {
    // Resolve provider
    const providerLocalName = tfResource.provider.localName;
    let resolved = providerMap.get(providerLocalName);

    if (resolved === undefined) {
      resolved = resolveProvider(providerLocalName, reporter);
      providerMap.set(providerLocalName, resolved);
    }

    // Derive resource name (deduplicate if needed)
    const baseName = deriveResourceName(tfResource);
    const count = nameCounts.get(baseName);
    const name =
      count === undefined ? baseName : `${baseName}_${String(count)}`;
    nameCounts.set(baseName, (count ?? 0) + 1);

    // Derive kind from TF resource type
    const kind = deriveResourceKind(tfResource.addressParts.type);

    // Determine mode
    const mode = tfResource.addressParts.mode === "data" ? "read" : "manage";

    // Flatten config into spec
    let spec: Record<string, unknown>;
    if (tfResource.config !== undefined) {
      spec = flattenConfig(tfResource.config, reporter, name);
    } else if (tfResource.state !== undefined) {
      // No config — use state values as the spec (observed state → desired config)
      spec = extractStateValues(tfResource);
    } else {
      spec = {};
    }

    // Detect references in spec values
    const { spec: finalSpec, refs } = detectRefs(spec, reporter, name);

    // Build ref bindings
    const refBindings: RefBindingIR[] = refs.map((ref) => ({
      specPath: ref.specPath,
      targetResource: ref.targetResource,
      statePath: ref.statePath,
    }));

    // Apply ref tokens to spec (already done in detectRefs via convertValue)
    // Extract depends_on from config meta
    const dependsOn =
      tfResource.config?.meta.dependsOn !== undefined
        ? tfResource.config.meta.dependsOn.map((addr) => {
            // Convert TF address to resource name
            const parts = addr.split(".");
            return parts[parts.length - 1] ?? addr;
          })
        : undefined;

    // Report address information loss
    if (tfResource.addressParts.modulePath.length > 0) {
      reporter.addIssue({
        path: `${name}.address.modulePath`,
        class: "lossy",
        message: `Module path "${tfResource.addressParts.modulePath.join(".")}" not modelled — InfraSync has flat resource namespace`,
        action: "dropped",
      });
    }

    if (tfResource.addressParts.instanceKey !== undefined) {
      reporter.addIssue({
        path: `${name}.address.instanceKey`,
        class: "lossy",
        message: `Instance key [${String(tfResource.addressParts.instanceKey)}] not modelled — expanded into individual resources`,
        action: "dropped",
      });
    }

    resources.push({
      name,
      provider: resolved.instanceKey,
      kind,
      mode,
      spec: finalSpec,
      ...(dependsOn !== undefined ? { dependsOn } : {}),
      ...(refBindings.length > 0 ? { refBindings } : {}),
    });
  }

  // Build provider instances
  const providers: ProviderInstanceIR[] = [];
  for (const resolved of new Set(providerMap.values())) {
    providers.push({
      key: resolved.instanceKey,
      adapterName: resolved.adapterName,
      config: {},
    });
  }

  // Report outputs/checks not modelled
  if (terraformIR.outputs.length > 0) {
    reporter.addIssue({
      path: "outputs",
      class: "lossy",
      message: `${String(terraformIR.outputs.length)} Terraform output(s) not modelled in InfraIR`,
      action: "dropped",
    });
  }

  if (terraformIR.checks.length > 0) {
    reporter.addIssue({
      path: "checks",
      class: "lossy",
      message: `${String(terraformIR.checks.length)} Terraform check(s) not modelled in InfraIR`,
      action: "dropped",
    });
  }

  const infraIR: InfraIR = {
    name: options.name ?? `imported-${terraformIR.source.format}`,
    providers,
    resources,
  };

  // Validate the output
  infraIRSchema.parse(infraIR);

  return reporter.result(infraIR);
}
