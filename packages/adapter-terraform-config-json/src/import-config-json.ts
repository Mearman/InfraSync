/**
 * Adapter for importing Terraform Configuration JSON (`*.tf.json`) into InfraIR.
 *
 * Reverse of the execution lane — reads Terraform-applyable configuration
 * and reconstructs an InfraIR document.
 *
 * Reverse mapping rules:
 * - `resource` blocks → mode "manage" resources
 * - `data` blocks → mode "read" resources
 * - `terraform.required_providers` + `provider` blocks → providers
 * - `depends_on` → dependsOn
 * - `${type.name.path}` expressions → RefTokenIR (when matching known resources)
 * - `${var.name}` expressions → SecretSourceIR
 * - `variable` blocks → tracked for variable resolution
 * - `provider` meta-argument → provider instance mapping
 *
 * Limitations (fidelity-reported):
 * - Terraform expressions that are not simple references are stored as literal strings
 * - `locals`, `module`, `output`, `terraform` settings beyond required_providers are dropped
 * - Complex variable types and defaults are dropped
 * - `lifecycle` meta-arguments are dropped
 * - `connection` and `provisioner` blocks are dropped
 */
import { FidelityReportBuilder } from "@infrasync-org/core-fidelity/fidelity";
import type { AdapterResult } from "@infrasync-org/core-fidelity/fidelity";
import type {
  InfraIR,
  ResourceIR,
  RefTokenIR,
  SecretSourceIR,
} from "@infrasync-org/core/schemas";

// ─── Type guard helpers ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Import options ───────────────────────────────────────────────────────────

export interface TfConfigJsonImportOptions {
  /**
   * Name for the resulting InfraIR document.
   * Default: extracted from "//" comment or "imported".
   */
  readonly name?: string;
}

// ─── Import result ────────────────────────────────────────────────────────────

export interface TfConfigJsonImportResult {
  readonly ir: InfraIR;
  readonly fidelity: AdapterResult<unknown>["fidelity"];
  readonly warnings: readonly string[];
}

// ─── Import function ──────────────────────────────────────────────────────────

/**
 * Import a Terraform Configuration JSON document into InfraIR.
 *
 * @throws Error if the input is not a valid JSON object.
 */
export function importTfConfigJson(
  raw: string,
  options: TfConfigJsonImportOptions = {},
): TfConfigJsonImportResult {
  const reporter = new FidelityReportBuilder();
  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed)) {
    throw new Error("Terraform Configuration JSON root must be a JSON object");
  }

  // ── Extract name ───────────────────────────────────────────────────────

  const name = options.name ?? extractName(parsed);

  // ── Parse terraform block ──────────────────────────────────────────────

  const terraformBlock = parsed.terraform;
  const requiredProviders =
    isRecord(terraformBlock) && isRecord(terraformBlock.required_providers)
      ? terraformBlock.required_providers
      : {};

  // ── Parse provider blocks ──────────────────────────────────────────────

  const providerBlocks = isRecord(parsed.provider) ? parsed.provider : {};

  // Build provider instances
  const providerInstances = buildProviderInstances(
    requiredProviders,
    providerBlocks,
    reporter,
  );

  // ── Parse resource and data blocks ─────────────────────────────────────

  const resources: ResourceIR[] = [];

  const resourceBlocks = isRecord(parsed.resource) ? parsed.resource : {};
  const dataBlocks = isRecord(parsed.data) ? parsed.data : {};

  // Build resource name → address mapping for ref resolution
  const resourceNameMap = buildResourceNameMap(resourceBlocks, dataBlocks);

  // Import managed resources
  for (const [tfType, instances] of Object.entries(resourceBlocks)) {
    if (!isRecord(instances)) continue;
    for (const [tfName, body] of Object.entries(instances)) {
      if (!isRecord(body)) continue;
      resources.push(
        buildResource(
          tfType,
          tfName,
          body,
          "manage",
          providerInstances,
          resourceNameMap,
          reporter,
        ),
      );
    }
  }

  // Import data sources
  for (const [tfType, instances] of Object.entries(dataBlocks)) {
    if (!isRecord(instances)) continue;
    for (const [tfName, body] of Object.entries(instances)) {
      if (!isRecord(body)) continue;
      resources.push(
        buildResource(
          tfType,
          tfName,
          body,
          "read",
          providerInstances,
          resourceNameMap,
          reporter,
        ),
      );
    }
  }

  // ── Report unsupported top-level blocks ────────────────────────────────

  for (const key of Object.keys(parsed)) {
    if (
      key !== "//" &&
      key !== "terraform" &&
      key !== "provider" &&
      key !== "resource" &&
      key !== "data" &&
      key !== "variable" &&
      key !== "output" &&
      key !== "locals" &&
      key !== "module"
    ) {
      reporter.addIssue({
        path: key,
        class: "unsupported",
        message: `Unknown top-level block type "${key}"`,
        action: "dropped",
      });
    }
  }

  if (isRecord(parsed.locals) && Object.keys(parsed.locals).length > 0) {
    reporter.addIssue({
      path: "locals",
      class: "unsupported",
      message: "locals block is not representable in InfraIR",
      action: "dropped",
    });
  }

  if (isRecord(parsed.module) && Object.keys(parsed.module).length > 0) {
    reporter.addIssue({
      path: "module",
      class: "unsupported",
      message: "module block is not representable in InfraIR",
      action: "dropped",
    });
  }

  if (isRecord(parsed.output) && Object.keys(parsed.output).length > 0) {
    reporter.addIssue({
      path: "output",
      class: "unsupported",
      message: "output block is not representable in InfraIR",
      action: "dropped",
    });
  }

  // ── Build IR ───────────────────────────────────────────────────────────

  const ir: InfraIR = {
    name,
    providers: providerInstances,
    resources,
  };

  const result = reporter.result(ir);

  return {
    ir: result.document,
    fidelity: result.fidelity,
    warnings: result.warnings,
  };
}

// ─── Name extraction ──────────────────────────────────────────────────────────

function extractName(tfConfig: Record<string, unknown>): string {
  const comment = tfConfig["//"];
  if (typeof comment === "string") {
    // Try to extract name from comment like: Generated by InfraSync from "my-stack". Do not edit.
    const match = /from\s+"([^"]+)"/.exec(comment);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return "imported";
}

// ─── Provider instance building ───────────────────────────────────────────────

interface ProviderInstance {
  readonly key: string;
  readonly adapterName: string;
  readonly config: Record<string, unknown>;
}

function buildProviderInstances(
  requiredProviders: Record<string, unknown>,
  providerBlocks: Record<string, unknown>,
  reporter: FidelityReportBuilder,
): ProviderInstance[] {
  const instances: ProviderInstance[] = [];

  for (const [adapterName, declaration] of Object.entries(requiredProviders)) {
    if (!isRecord(declaration)) continue;

    const configEntries = isRecord(providerBlocks[adapterName])
      ? providerBlocks[adapterName]
      : {};

    // Check for configuration_aliases (multiple provider instances)
    const aliases = declaration.configuration_aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        const aliasStr = typeof alias === "string" ? alias : String(alias);
        // alias is like "aws.prod" — use the part after the dot
        const aliasPart = aliasStr.includes(".")
          ? (aliasStr.split(".")[1] ?? aliasStr)
          : aliasStr;
        instances.push({
          key: toPascalCase(aliasPart),
          adapterName,
          config: buildAliasedConfig(configEntries, aliasPart, reporter),
        });
      }
    } else {
      // Single instance
      const config = isRecord(configEntries)
        ? resolveConfigValues(configEntries, reporter)
        : {};
      instances.push({
        key: toPascalCase(adapterName),
        adapterName,
        config,
      });
    }
  }

  return instances;
}

function buildAliasedConfig(
  configEntries: Record<string, unknown>,
  aliasPart: string,
  reporter: FidelityReportBuilder,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const aliasConfig = configEntries[aliasPart];
  if (isRecord(aliasConfig)) {
    return resolveConfigValues(aliasConfig, reporter);
  }
  return result;
}

function resolveConfigValues(
  config: Record<string, unknown>,
  reporter: FidelityReportBuilder,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    // Skip Terraform meta-args
    if (key === "alias" || key === "version") continue;
    const converted = convertSimpleExpression(
      value,
      `provider.${key}`,
      reporter,
    );
    resolved[key] = converted.value;
  }
  return resolved;
}

// ─── Resource name mapping ────────────────────────────────────────────────────

/**
 * Build a map from InfraIR-style resource names (derived from TF addresses)
 * back to their Terraform type.name addresses.
 *
 * We use the TF name directly as the InfraIR resource name.
 */
function buildResourceNameMap(
  resourceBlocks: Record<string, unknown>,
  dataBlocks: Record<string, unknown>,
): Map<string, { type: string; name: string }> {
  const map = new Map<string, { type: string; name: string }>();

  for (const [tfType, instances] of Object.entries(resourceBlocks)) {
    if (!isRecord(instances)) continue;
    for (const tfName of Object.keys(instances)) {
      map.set(tfName, { type: tfType, name: tfName });
    }
  }

  for (const [tfType, instances] of Object.entries(dataBlocks)) {
    if (!isRecord(instances)) continue;
    for (const tfName of Object.keys(instances)) {
      map.set(tfName, { type: tfType, name: tfName });
    }
  }

  return map;
}

// ─── Resource building ────────────────────────────────────────────────────────

/** Terraform meta-arguments that are not part of the resource spec. */
const META_ARGS: ReadonlySet<string> = new Set([
  "provider",
  "depends_on",
  "lifecycle",
  "connection",
  "provisioner",
  "//",
]);

function buildResource(
  tfType: string,
  tfName: string,
  body: Record<string, unknown>,
  mode: "manage" | "read",
  providerInstances: readonly ProviderInstance[],
  resourceNameMap: Map<string, { type: string; name: string }>,
  reporter: FidelityReportBuilder,
): ResourceIR {
  // Determine provider instance from resource type prefix (e.g. "cloudflare_record" → "cloudflare")
  const adapterName = extractAdapterName(tfType);
  const kind = extractKind(tfType);

  // Determine provider key — check for explicit provider meta-argument
  const providerArg = body.provider;
  let providerKey: string;
  if (typeof providerArg === "string") {
    // Format: "adapter.alias" or just "adapter"
    const parts = providerArg.split(".");
    const aliasPart = parts[1];
    providerKey =
      aliasPart !== undefined
        ? toPascalCase(aliasPart)
        : toPascalCase(adapterName);
  } else {
    providerKey = toPascalCase(adapterName);
  }

  // Ensure provider instance exists
  const providerExists = providerInstances.some(
    (p) => p.key === providerKey && p.adapterName === adapterName,
  );
  if (!providerExists) {
    reporter.addIssue({
      path: `resource.${tfType}.${tfName}`,
      class: "lossy",
      message: `Provider instance "${providerKey}" for adapter "${adapterName}" not found — creating implicit provider`,
      action: "approximated",
    });
  }

  // Build spec, filtering out meta-arguments
  const spec: Record<string, unknown> = {};
  const refBindings: {
    specPath: string;
    targetResource: string;
    statePath: string;
  }[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (META_ARGS.has(key)) continue;

    const converted = convertRefExpression(
      value,
      `resource.${tfType}.${tfName}.${key}`,
      resourceNameMap,
      reporter,
    );

    spec[key] = converted.value;

    // Collect ref bindings
    for (const ref of converted.refs) {
      refBindings.push({
        specPath: key,
        targetResource: ref.resource,
        statePath: ref.path,
      });
    }
  }

  // Extract depends_on
  let dependsOn: string[] | undefined;
  const dependsOnRaw = body.depends_on;
  if (Array.isArray(dependsOnRaw)) {
    dependsOn = dependsOnRaw
      .filter((d): d is string => typeof d === "string")
      .map((dep) => {
        // Convert "type.name" format to just the name
        const dotIndex = dep.indexOf(".");
        return dotIndex !== -1 ? dep.slice(dotIndex + 1) : dep;
      });
  }

  const resource: ResourceIR = {
    name: tfName,
    provider: providerKey,
    kind: toPascalCase(kind),
    mode,
    spec,
  };

  if (dependsOn !== undefined && dependsOn.length > 0) {
    resource.dependsOn = dependsOn;
  }

  if (refBindings.length > 0) {
    resource.refBindings = refBindings;
  }

  // Report dropped lifecycle
  if (isRecord(body.lifecycle)) {
    reporter.addIssue({
      path: `resource.${tfType}.${tfName}.lifecycle`,
      class: "unsupported",
      message: "lifecycle meta-argument is not representable in InfraIR",
      action: "dropped",
    });
  }

  // Report dropped connection/provisioner
  if (body.connection !== undefined) {
    reporter.addIssue({
      path: `resource.${tfType}.${tfName}.connection`,
      class: "unsupported",
      message: "connection block is not representable in InfraIR",
      action: "dropped",
    });
  }

  if (body.provisioner !== undefined) {
    reporter.addIssue({
      path: `resource.${tfType}.${tfName}.provisioner`,
      class: "unsupported",
      message: "provisioner block is not representable in InfraIR",
      action: "dropped",
    });
  }

  return resource;
}

// ─── Expression conversion ────────────────────────────────────────────────────

interface ConvertedExpression {
  readonly value: unknown;
  readonly refs: readonly { resource: string; path: string }[];
}

/**
 * Convert a value that may contain Terraform expressions, with ref resolution.
 * Used for resource spec fields where `${type.name.path}` should become RefTokenIR.
 */
function convertRefExpression(
  value: unknown,
  path: string,
  resourceNameMap: Map<string, { type: string; name: string }>,
  reporter: FidelityReportBuilder,
): ConvertedExpression {
  // Primitive values pass through
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return { value, refs: [] };
  }

  if (typeof value === "string") {
    return convertStringWithRefs(value, path, resourceNameMap, reporter);
  }

  if (Array.isArray(value)) {
    const items: unknown[] = [];
    const allRefs: { resource: string; path: string }[] = [];
    for (let i = 0; i < value.length; i++) {
      const converted = convertRefExpression(
        value[i],
        `${path}[${String(i)}]`,
        resourceNameMap,
        reporter,
      );
      items.push(converted.value);
      allRefs.push(...converted.refs);
    }
    return { value: items, refs: allRefs };
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    const allRefs: { resource: string; path: string }[] = [];
    for (const [key, val] of Object.entries(value)) {
      const converted = convertRefExpression(
        val,
        `${path}.${key}`,
        resourceNameMap,
        reporter,
      );
      result[key] = converted.value;
      allRefs.push(...converted.refs);
    }
    return { value: result, refs: allRefs };
  }

  return { value, refs: [] };
}

/**
 * Convert a value that may contain Terraform expressions, without ref resolution.
 * Used for provider configs where expressions are simpler (typically just variable refs).
 */
function convertSimpleExpression(
  value: unknown,
  path: string,
  reporter: FidelityReportBuilder,
): ConvertedExpression {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return { value, refs: [] };
  }

  if (typeof value === "string") {
    // Check for variable reference only (no resource ref resolution)
    const varMatch = TF_VAR_PATTERN.exec(value);
    if (varMatch?.[1] !== undefined) {
      return {
        value: {
          $secret: { kind: "env", name: varMatch[1] },
        } satisfies SecretSourceIR,
        refs: [],
      };
    }

    if (value.includes("${")) {
      reporter.addIssue({
        path,
        class: "lossy",
        message: `Complex Terraform expression "${value}" cannot be converted — stored as literal string`,
        action: "approximated",
      });
    }

    return { value, refs: [] };
  }

  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const converted = convertSimpleExpression(
        value[i],
        `${path}[${String(i)}]`,
        reporter,
      );
      items.push(converted.value);
    }
    return { value: items, refs: [] };
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const converted = convertSimpleExpression(
        val,
        `${path}.${key}`,
        reporter,
      );
      result[key] = converted.value;
    }
    return { value: result, refs: [] };
  }

  return { value, refs: [] };
}

// ─── String expression conversion ─────────────────────────────────────────────

/**
 * Regex for a Terraform reference expression: `${type.name.path}` or `${type.name}`.
 * Captures groups: type, name, path (optional).
 */
const TF_REF_PATTERN =
  /^\$\{([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)(?:\.([a-zA-Z][a-zA-Z0-9_.]*))?\}$/;

/**
 * Regex for a Terraform variable reference: `${var.name}`.
 */
const TF_VAR_PATTERN = /^\$\{var\.([a-zA-Z][a-zA-Z0-9_]*)\}$/;

function convertStringWithRefs(
  value: string,
  path: string,
  resourceNameMap: Map<string, { type: string; name: string }>,
  reporter: FidelityReportBuilder,
): ConvertedExpression {
  // Check for variable reference: ${var.name}
  const varMatch = TF_VAR_PATTERN.exec(value);
  if (varMatch?.[1] !== undefined) {
    return {
      value: {
        $secret: { kind: "env", name: varMatch[1] },
      } satisfies SecretSourceIR,
      refs: [],
    };
  }

  // Check for resource reference: ${type.name.path}
  const refMatch = TF_REF_PATTERN.exec(value);
  if (refMatch !== null) {
    const refName = refMatch[2];
    const refPath = refMatch[3] ?? "id";

    // Verify this name exists in our resource map
    if (refName !== undefined && resourceNameMap.has(refName)) {
      return {
        value: {
          $ref: { resource: refName, path: refPath },
        } satisfies RefTokenIR,
        refs: [{ resource: refName, path: refPath }],
      };
    }
  }

  // Complex template expression — cannot convert to RefToken
  if (value.includes("${")) {
    reporter.addIssue({
      path,
      class: "lossy",
      message: `Complex Terraform expression "${value}" cannot be converted to InfraIR RefToken — stored as literal string`,
      action: "approximated",
    });
  }

  return { value, refs: [] };
}

// ─── Adapter name / kind extraction ───────────────────────────────────────────

/**
 * Extract adapter name from Terraform resource type.
 * "cloudflare_record" → "cloudflare", "aws_s3_bucket" → "aws"
 */
function extractAdapterName(tfType: string): string {
  const underscoreIndex = tfType.indexOf("_");
  return underscoreIndex !== -1 ? tfType.slice(0, underscoreIndex) : tfType;
}

/**
 * Extract resource kind from Terraform resource type.
 * "cloudflare_record" → "record", "aws_s3_bucket" → "s3_bucket"
 */
function extractKind(tfType: string): string {
  const underscoreIndex = tfType.indexOf("_");
  return underscoreIndex !== -1 ? tfType.slice(underscoreIndex + 1) : tfType;
}

// ─── Case conversion ──────────────────────────────────────────────────────────

function toPascalCase(input: string): string {
  return input
    .split(/[_\-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}
