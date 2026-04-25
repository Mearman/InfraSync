import type {
  InfraIR,
  ProviderInstanceIR,
  RefTokenIR,
  ResourceIR,
  SecretSourceIR,
} from "@infrasync/core/types";
import type {
  ExportResult,
  ExportWarning,
  Exporter,
  GeneratedFile,
} from "./types.js";

const INDENT_UNIT = "  ";
const DEFAULT_PROVIDER_SOURCES = Object.freeze({
  aws: "hashicorp/aws",
  cloudflare: "cloudflare/cloudflare",
  github: "integrations/github",
  google: "hashicorp/google",
  supabase: "supabase/supabase",
  vercel: "vercel/vercel",
});

interface RawCodeValue {
  readonly __raw: string;
}

type CodePrimitive = string | number | boolean | null;

type CodeArray = CodeValue[];

interface CodeObject {
  [key: string]: CodeValue;
}

type CodeValue = CodePrimitive | RawCodeValue | CodeArray | CodeObject;

interface ProviderBinding {
  readonly instanceKey: string;
  readonly adapterName: string;
  readonly localName: string;
  readonly alias: string | undefined;
  readonly isDefault: boolean;
}

interface ProviderContext {
  readonly bindingsByInstanceKey: ReadonlyMap<string, ProviderBinding>;
  readonly providersByInstanceKey: ReadonlyMap<string, ProviderInstanceIR>;
}

interface ResourceBinding {
  readonly resource: ResourceIR;
  readonly terraformType: string;
  readonly terraformName: string;
  readonly mode: "manage" | "read";
}

interface BuildContext {
  readonly resourcesByName: ReadonlyMap<string, ResourceBinding>;
}

export interface CdktfTypeScriptExportOptions {
  readonly stackName?: string | undefined;
  readonly providerSources?: Readonly<Record<string, string>> | undefined;
}

export const cdktfTypeScriptExporter: Exporter<CdktfTypeScriptExportOptions> = {
  format: "cdktf-ts",
  generate(
    ir: InfraIR,
    options: CdktfTypeScriptExportOptions,
  ): Promise<ExportResult> {
    const providerSources = {
      ...DEFAULT_PROVIDER_SOURCES,
      ...(options.providerSources ?? {}),
    };

    const warnings: ExportWarning[] = [];
    const providerContext = buildProviderContext(ir.providers, providerSources);
    const resourceBindings = buildResourceBindings(
      ir.resources,
      providerContext.bindingsByInstanceKey,
    );

    const buildContext: BuildContext = {
      resourcesByName: resourceBindings,
    };

    const requiredProviders = buildRequiredProviders(
      providerContext.bindingsByInstanceKey,
      providerSources,
    );
    const providerConfiguration = buildProviderConfiguration(
      providerContext,
      warnings,
    );
    const translatedResources = buildTerraformResourceBlocks(
      resourceBindings,
      providerContext.bindingsByInstanceKey,
      buildContext,
      warnings,
    );

    const stackId = sanitiseIdentifier(options.stackName ?? ir.name, "stack");
    const className = `${toPascalCase(stackId)}Stack`;

    const files: GeneratedFile[] = [
      {
        path: "main.ts",
        content: buildMainTypeScriptFile({
          className,
          stackId,
          requiredProviders,
          providerConfiguration,
          managedResources: translatedResources.managedResources,
          dataResources: translatedResources.dataResources,
        }),
      },
      {
        path: "cdktf.json",
        content: JSON.stringify(
          {
            language: "typescript",
            app: "pnpm tsx main.ts",
            projectId: sanitiseIdentifier(ir.name, "infrasync"),
            sendCrashReports: "false",
            terraformProviders: [],
            terraformModules: [],
            codeMakerOutput: "imports",
            context: {},
          },
          null,
          2,
        ),
      },
      {
        path: "package.json",
        content: JSON.stringify(
          {
            name: `${sanitiseIdentifier(ir.name, "infrasync")}-cdktf-generated`,
            private: true,
            type: "module",
            scripts: {
              synth: "cdktf synth",
              diff: "cdktf diff",
              deploy: "cdktf deploy",
              destroy: "cdktf destroy",
            },
            dependencies: {
              cdktf: "^0.20.8",
              constructs: "^10.4.2",
            },
            devDependencies: {
              "cdktf-cli": "^0.20.8",
              tsx: "^4.21.0",
              typescript: "^5.9.3",
            },
          },
          null,
          2,
        ),
      },
      {
        path: "tsconfig.json",
        content: JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
              skipLibCheck: true,
              esModuleInterop: true,
            },
            include: ["main.ts"],
          },
          null,
          2,
        ),
      },
      {
        path: "README.md",
        content: buildReadmeFile(warnings),
      },
      {
        path: ".gitignore",
        content: "cdktf.out\nnode_modules\n",
      },
    ];

    return Promise.resolve({
      files,
      warnings,
    });
  },
};

function buildMainTypeScriptFile(args: {
  readonly className: string;
  readonly stackId: string;
  readonly requiredProviders: Record<string, CodeValue>;
  readonly providerConfiguration: Record<string, CodeValue>;
  readonly managedResources: Record<string, CodeValue>;
  readonly dataResources: Record<string, CodeValue>;
}): string {
  const requiredProvidersCode = renderCodeValue(args.requiredProviders, 0);
  const providerConfigurationCode = renderCodeValue(
    args.providerConfiguration,
    0,
  );
  const managedResourcesCode = renderCodeValue(args.managedResources, 0);
  const dataResourcesCode = renderCodeValue(args.dataResources, 0);

  return `import { App, TerraformStack } from "cdktf";
import type { Construct } from "constructs";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(\`Environment variable "\${name}" is required by generated Terraform configuration\`);
  }
  return value;
}

const TERRAFORM_REQUIRED_PROVIDERS = ${requiredProvidersCode};
const TERRAFORM_PROVIDER_CONFIGURATION = ${providerConfigurationCode};
const TERRAFORM_MANAGED_RESOURCES = ${managedResourcesCode};
const TERRAFORM_DATA_SOURCES = ${dataResourcesCode};

class ${args.className} extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.addOverride("terraform", {
      required_providers: TERRAFORM_REQUIRED_PROVIDERS,
    });

    if (Object.keys(TERRAFORM_PROVIDER_CONFIGURATION).length > 0) {
      this.addOverride("provider", TERRAFORM_PROVIDER_CONFIGURATION);
    }

    if (Object.keys(TERRAFORM_MANAGED_RESOURCES).length > 0) {
      this.addOverride("resource", TERRAFORM_MANAGED_RESOURCES);
    }

    if (Object.keys(TERRAFORM_DATA_SOURCES).length > 0) {
      this.addOverride("data", TERRAFORM_DATA_SOURCES);
    }
  }
}

const app = new App();
new ${args.className}(app, "${args.stackId}");
app.synth();
`;
}

function buildReadmeFile(warnings: readonly ExportWarning[]): string {
  const warningLines =
    warnings.length === 0
      ? "- No generation warnings were emitted."
      : warnings
          .map((warning) => `- [${warning.code}] ${warning.message}`)
          .join("\n");

  return `# Generated CDKTF project

This directory was generated by \`infrasync export cdktf-ts\`.

## Quick start

1. Install dependencies:

   \`\`\`bash
   pnpm install
   \`\`\`

2. Set required environment variables for provider credentials.

3. Synthesis:

   \`\`\`bash
   pnpm synth
   \`\`\`

## Notes

- The generated stack uses CDKTF's TypeScript SDK and emits raw Terraform JSON via \`addOverride\`.
- Provider and resource argument translation is heuristic and may need manual refinement.
- Treat this project as a reviewable starting point before production use.

## Generation warnings

${warningLines}
`;
}

function buildProviderContext(
  providers: readonly ProviderInstanceIR[],
  providerSources: Readonly<Record<string, string>>,
): ProviderContext {
  const providersByAdapter = new Map<string, ProviderInstanceIR[]>();
  const providersByInstanceKey = new Map<string, ProviderInstanceIR>();

  for (const provider of providers) {
    if (providersByInstanceKey.has(provider.key)) {
      throw new Error(
        `Duplicate provider instance key "${provider.key}" detected while generating Terraform export`,
      );
    }

    providersByInstanceKey.set(provider.key, provider);

    const current = providersByAdapter.get(provider.adapterName) ?? [];
    current.push(provider);
    providersByAdapter.set(provider.adapterName, current);
  }

  const adapterLocalNames = buildAdapterLocalNameMap(
    [...providersByAdapter.keys()],
    providerSources,
  );

  const bindingsByInstanceKey = new Map<string, ProviderBinding>();

  const sortedAdapterNames = [...providersByAdapter.keys()].sort(
    (left, right) => left.localeCompare(right),
  );

  for (const adapterName of sortedAdapterNames) {
    const localName = adapterLocalNames.get(adapterName);
    if (localName === undefined) {
      throw new Error(
        `No Terraform local provider name for adapter "${adapterName}"`,
      );
    }

    const group = (providersByAdapter.get(adapterName) ?? []).toSorted((a, b) =>
      a.key.localeCompare(b.key),
    );
    const defaultProvider = selectDefaultProvider(adapterName, group);
    const usedAliases = new Set<string>();

    for (const provider of group) {
      const isDefault = provider.key === defaultProvider.key;
      const alias = isDefault
        ? undefined
        : makeUniqueIdentifier(
            sanitiseIdentifier(provider.key, "alias"),
            usedAliases,
          );

      bindingsByInstanceKey.set(provider.key, {
        instanceKey: provider.key,
        adapterName,
        localName,
        alias,
        isDefault,
      });
    }
  }

  return {
    bindingsByInstanceKey,
    providersByInstanceKey,
  };
}

function buildAdapterLocalNameMap(
  adapterNames: readonly string[],
  providerSources: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const usedLocalNames = new Set<string>();

  const sortedAdapterNames = [...adapterNames].sort((left, right) =>
    left.localeCompare(right),
  );

  for (const adapterName of sortedAdapterNames) {
    const source = providerSources[adapterName];
    const fromSource = source?.split("/").at(-1);
    const base = fromSource ?? adapterName;
    const unique = makeUniqueIdentifier(
      sanitiseIdentifier(base, "provider"),
      usedLocalNames,
    );
    map.set(adapterName, unique);
  }

  return map;
}

function selectDefaultProvider(
  adapterName: string,
  providers: readonly ProviderInstanceIR[],
): ProviderInstanceIR {
  const exactMatch = providers.find((provider) => provider.key === adapterName);
  if (exactMatch !== undefined) {
    return exactMatch;
  }

  const first = providers[0];
  if (first === undefined) {
    throw new Error(`Adapter "${adapterName}" has no provider instances`);
  }

  return first;
}

function buildRequiredProviders(
  bindingsByInstanceKey: ReadonlyMap<string, ProviderBinding>,
  providerSources: Readonly<Record<string, string>>,
): Record<string, CodeValue> {
  const providersByLocalName = new Map<string, string>();

  for (const binding of bindingsByInstanceKey.values()) {
    if (!providersByLocalName.has(binding.localName)) {
      providersByLocalName.set(binding.localName, binding.adapterName);
    }
  }

  const requiredProviders: Record<string, CodeValue> = {};

  const entries = [...providersByLocalName.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  );

  for (const [localName, adapterName] of entries) {
    const source = providerSources[adapterName];
    if (source === undefined) {
      throw new Error(
        `No Terraform provider source mapping for adapter "${adapterName}". Pass --provider-source ${adapterName}=<registry/source>`,
      );
    }

    requiredProviders[localName] = { source };
  }

  return requiredProviders;
}

function buildProviderConfiguration(
  providerContext: ProviderContext,
  warnings: ExportWarning[],
): Record<string, CodeValue> {
  const groupedByLocalName = new Map<
    string,
    {
      binding: ProviderBinding;
      provider: ProviderInstanceIR;
    }[]
  >();

  const sortedBindings = [
    ...providerContext.bindingsByInstanceKey.values(),
  ].toSorted((left, right) =>
    left.instanceKey.localeCompare(right.instanceKey),
  );

  for (const binding of sortedBindings) {
    const provider = providerContext.providersByInstanceKey.get(
      binding.instanceKey,
    );
    if (provider === undefined) {
      throw new Error(
        `Provider instance "${binding.instanceKey}" is missing provider configuration`,
      );
    }

    const current = groupedByLocalName.get(binding.localName) ?? [];
    current.push({ binding, provider });
    groupedByLocalName.set(binding.localName, current);
  }

  const providerBlock: Record<string, CodeValue> = {};

  const groupedEntries = [...groupedByLocalName.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  );

  for (const [localName, entries] of groupedEntries) {
    const sortedEntries = entries.toSorted((left, right) => {
      if (left.binding.isDefault && !right.binding.isDefault) return -1;
      if (!left.binding.isDefault && right.binding.isDefault) return 1;
      return left.binding.instanceKey.localeCompare(right.binding.instanceKey);
    });

    if (sortedEntries.length === 1) {
      const first = sortedEntries[0];
      if (first !== undefined) {
        providerBlock[localName] = toTerraformCodeValue(
          first.provider.config,
          warnings,
          "provider",
        );
      }
      continue;
    }

    providerBlock[localName] = sortedEntries.map((entry) => {
      const translated = toTerraformObjectCodeValue(
        entry.provider.config,
        warnings,
        "provider",
      );

      if (entry.binding.alias === undefined) {
        return translated;
      }

      return {
        alias: entry.binding.alias,
        ...translated,
      };
    });
  }

  return providerBlock;
}

function buildResourceBindings(
  resources: readonly ResourceIR[],
  bindingsByInstanceKey: ReadonlyMap<string, ProviderBinding>,
): ReadonlyMap<string, ResourceBinding> {
  const bindingsByResourceName = new Map<string, ResourceBinding>();
  const usedNamesByBucket = new Map<string, Set<string>>();

  const sortedResources = [...resources].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const resource of sortedResources) {
    const providerBinding = bindingsByInstanceKey.get(resource.provider);
    if (providerBinding === undefined) {
      throw new Error(
        `Resource "${resource.name}" references unknown provider instance "${resource.provider}"`,
      );
    }

    const terraformType = `${providerBinding.localName}_${toSnakeCase(resource.kind)}`;
    const bucketKey = `${resource.mode}:${terraformType}`;
    const usedNames = usedNamesByBucket.get(bucketKey) ?? new Set<string>();
    const terraformName = makeUniqueIdentifier(
      sanitiseIdentifier(resource.name, "resource"),
      usedNames,
    );
    usedNamesByBucket.set(bucketKey, usedNames);

    if (bindingsByResourceName.has(resource.name)) {
      throw new Error(
        `Duplicate resource name "${resource.name}" detected while generating Terraform export`,
      );
    }

    bindingsByResourceName.set(resource.name, {
      resource,
      terraformType,
      terraformName,
      mode: resource.mode,
    });
  }

  return bindingsByResourceName;
}

function buildTerraformResourceBlocks(
  resourceBindings: ReadonlyMap<string, ResourceBinding>,
  providerBindings: ReadonlyMap<string, ProviderBinding>,
  context: BuildContext,
  warnings: ExportWarning[],
): {
  readonly managedResources: Record<string, CodeValue>;
  readonly dataResources: Record<string, CodeValue>;
} {
  const managedResources: Record<string, CodeValue> = {};
  const dataResources: Record<string, CodeValue> = {};

  const sortedBindings = [...resourceBindings.values()].toSorted(
    (left, right) => left.resource.name.localeCompare(right.resource.name),
  );

  for (const binding of sortedBindings) {
    const providerBinding = providerBindings.get(binding.resource.provider);
    if (providerBinding === undefined) {
      throw new Error(
        `Resource "${binding.resource.name}" references unknown provider instance "${binding.resource.provider}"`,
      );
    }

    const collection =
      binding.mode === "manage" ? managedResources : dataResources;
    const typedGroup = getOrCreateObject(collection, binding.terraformType);

    const specWithoutKind = removeKindField(
      binding.resource.spec,
      binding.resource.kind,
    );

    const translatedSpec = toTerraformObjectCodeValue(
      specWithoutKind,
      warnings,
      "resource",
      context,
    );

    const body: Record<string, CodeValue> = {
      ...translatedSpec,
    };

    if (!providerBinding.isDefault && providerBinding.alias !== undefined) {
      body.provider = `${providerBinding.localName}.${providerBinding.alias}`;
    }

    const dependsOn = binding.resource.dependsOn;
    if (dependsOn !== undefined && dependsOn.length > 0) {
      body.depends_on = dependsOn.map((dependencyName) => {
        const dependency = resourceBindings.get(dependencyName);
        if (dependency === undefined) {
          throw new Error(
            `Resource "${binding.resource.name}" depends on unknown resource "${dependencyName}"`,
          );
        }
        return toTerraformDependsOnReference(dependency);
      });
    }

    typedGroup[binding.terraformName] = body;
  }

  return {
    managedResources,
    dataResources,
  };
}

function removeKindField(
  input: Readonly<Record<string, unknown>>,
  expectedKind: string,
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (key === "kind" && value === expectedKind) {
      continue;
    }

    output[key] = value;
  }

  return output;
}

function toTerraformDependsOnReference(binding: ResourceBinding): string {
  if (binding.mode === "manage") {
    return `${binding.terraformType}.${binding.terraformName}`;
  }

  return `data.${binding.terraformType}.${binding.terraformName}`;
}

function toTerraformInterpolationReference(
  ref: RefTokenIR,
  context: BuildContext,
): string {
  const target = context.resourcesByName.get(ref.$ref.resource);
  if (target === undefined) {
    throw new Error(
      `Reference target "${ref.$ref.resource}" does not exist in the generated graph`,
    );
  }

  const traversal = toTerraformTraversal(ref.$ref.path);
  const prefix = target.mode === "manage" ? "" : "data.";
  return `\${${prefix}${target.terraformType}.${target.terraformName}.${traversal}}`;
}

function toTerraformTraversal(path: string): string {
  const segments = path.split(".");

  return segments
    .map((segment) => {
      const indexStart = segment.indexOf("[");
      if (indexStart === -1) {
        return toSnakeCase(segment);
      }

      const base = segment.slice(0, indexStart);
      const suffix = segment.slice(indexStart);
      return `${toSnakeCase(base)}${suffix}`;
    })
    .join(".");
}

function toTerraformObjectCodeValue(
  input: Readonly<Record<string, unknown>>,
  warnings: ExportWarning[],
  source: "provider" | "resource",
  context?: BuildContext,
): Record<string, CodeValue> {
  const output: Record<string, CodeValue> = {};

  const entries = Object.entries(input).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );

  for (const [key, value] of entries) {
    const terraformKey = toTerraformAttributeKey(key);
    if (terraformKey !== key) {
      warnings.push({
        code: "KEY_CASE_CONVERTED",
        message: `${source} key "${key}" was converted to "${terraformKey}" for Terraform compatibility`,
      });
    }

    output[terraformKey] = toTerraformCodeValue(
      value,
      warnings,
      source,
      context,
    );
  }

  return output;
}

function toTerraformCodeValue(
  value: unknown,
  warnings: ExportWarning[],
  source: "provider" | "resource",
  context?: BuildContext,
): CodeValue {
  if (isRefTokenIR(value)) {
    if (context === undefined) {
      throw new Error(
        "RefToken cannot be translated without resource graph context",
      );
    }
    return toTerraformInterpolationReference(value, context);
  }

  if (isSecretSourceIR(value)) {
    warnings.push({
      code: "SECRET_ENV_REQUIRED",
      message: `Secret source "${value.$secret.name}" was mapped to requireEnv("${value.$secret.name}") in generated TypeScript`,
    });
    return rawCode(`requireEnv(${JSON.stringify(value.$secret.name)})`);
  }

  if (value === null) return null;

  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((item) =>
      toTerraformCodeValue(item, warnings, source, context),
    );
  }

  if (isRecord(value)) {
    return toTerraformObjectCodeValue(value, warnings, source, context);
  }

  throw new Error(
    `Unsupported value type "${typeof value}" encountered while translating ${source} configuration`,
  );
}

function isRefTokenIR(value: unknown): value is RefTokenIR {
  if (!isRecord(value)) return false;
  if (!Object.hasOwn(value, "$ref")) return false;

  const refValue = value.$ref;
  if (!isRecord(refValue)) return false;
  if (!Object.hasOwn(refValue, "resource")) return false;
  if (!Object.hasOwn(refValue, "path")) return false;

  return (
    typeof refValue.resource === "string" && typeof refValue.path === "string"
  );
}

function isSecretSourceIR(value: unknown): value is SecretSourceIR {
  if (!isRecord(value)) return false;
  if (!Object.hasOwn(value, "$secret")) return false;

  const secretValue = value.$secret;
  if (!isRecord(secretValue)) return false;
  if (!Object.hasOwn(secretValue, "kind")) return false;
  if (!Object.hasOwn(secretValue, "name")) return false;

  return secretValue.kind === "env" && typeof secretValue.name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawCode(code: string): RawCodeValue {
  return { __raw: code };
}

function isRawCodeValue(value: CodeValue): value is RawCodeValue {
  if (!isCodeObject(value)) return false;
  return Object.hasOwn(value, "__raw") && typeof value.__raw === "string";
}

function isCodeObject(value: CodeValue): value is Record<string, CodeValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderCodeValue(value: CodeValue, depth: number): string {
  if (isRawCodeValue(value)) {
    return value.__raw;
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    const inner = value
      .map((item) => `${indent(depth + 1)}${renderCodeValue(item, depth + 1)}`)
      .join(",\n");

    return `[
${inner}
${indent(depth)}]`;
  }

  const entries = Object.entries(value).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );

  if (entries.length === 0) {
    return "{}";
  }

  const body = entries
    .map(
      ([key, entryValue]) =>
        `${indent(depth + 1)}${JSON.stringify(key)}: ${renderCodeValue(entryValue, depth + 1)}`,
    )
    .join(",\n");

  return `{
${body}
${indent(depth)}}`;
}

function indent(depth: number): string {
  return INDENT_UNIT.repeat(depth);
}

function getOrCreateObject(
  target: Record<string, CodeValue>,
  key: string,
): Record<string, CodeValue> {
  const existing = target[key];

  if (existing !== undefined) {
    if (!isCodeObject(existing) || isRawCodeValue(existing)) {
      throw new Error(
        `Key "${key}" is already populated with a non-object value`,
      );
    }

    return existing;
  }

  const created: Record<string, CodeValue> = {};
  target[key] = created;
  return created;
}

function toTerraformAttributeKey(key: string): string {
  const isSimpleIdentifier = /^[a-z][A-Za-z0-9]*$/u.test(key);
  if (!isSimpleIdentifier) {
    return key;
  }

  return toSnakeCase(key);
}

function sanitiseIdentifier(value: string, fallbackPrefix: string): string {
  const trimmed = value.trim();
  const snake = toSnakeCase(trimmed.length > 0 ? trimmed : fallbackPrefix);

  if (/^[0-9]/u.test(snake)) {
    return `${fallbackPrefix}_${snake}`;
  }

  return snake;
}

function makeUniqueIdentifier(base: string, used: Set<string>): string {
  let candidate = base;
  let counter = 2;

  while (used.has(candidate)) {
    candidate = `${base}_${String(counter)}`;
    counter += 1;
  }

  used.add(candidate);
  return candidate;
}

function toSnakeCase(value: string): string {
  const withWordBoundaries = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[\s\-]+/gu, "_")
    .replace(/[^A-Za-z0-9_]/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();

  if (withWordBoundaries.length === 0) {
    return "value";
  }

  return withWordBoundaries;
}

function toPascalCase(value: string): string {
  const segments = value
    .split(/[_\-\s]+/u)
    .filter((segment) => segment.length > 0);

  return segments
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}
