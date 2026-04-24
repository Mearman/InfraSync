import type {
  InfraIR,
  ProviderInstanceIR,
  RefBindingIR,
  ResourceIR,
} from "../ir/types.js";
import { InfraScope } from "./infra.js";
import type { ResourceHandle } from "./handles.js";
import { isRefToken, refTokenToIR } from "../core/refs.js";

// ─── Type guard ──────────────────────────────────────────────────────────────

/**
 * Narrows `unknown` to `Record<string, unknown>`.
 * Replaces all `spec as Record<string, unknown>` assertions with a proper guard.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Define the root infrastructure scope.
 *
 * Creates an InfraScope, runs the authoring callback, and returns an object
 * with `toIR()` for compiling to InfraIR.
 *
 * Usage:
 *
 * ```typescript
 * const infra = defineInfra("prod", (infra) => {
 *   const awsProd = infra.provider("awsProd", aws, config);
 *   const bucket = awsProd.s3Bucket("bucket", spec);
 *   return { outputs: { endpoint: bucket.ref.websiteEndpoint } };
 * });
 *
 * const ir = infra.toIR();
 * ```
 */
export function defineInfra<TOutputs>(
  name: string,
  fn: (infra: InfraScope) => { outputs: TOutputs },
): InfraResult<TOutputs> {
  const scope = new InfraScope(name);
  const result = fn(scope);
  return {
    name,
    toIR: () => compileToIR(scope),
    outputs: result.outputs,
  };
}

/** The result of defineInfra() — can be compiled to InfraIR. */
export interface InfraResult<TOutputs> {
  readonly name: string;
  toIR(): InfraIR;
  readonly outputs: TOutputs;
}

// ─── Compilation ─────────────────────────────────────────────────────────────

/**
 * Compile an InfraScope tree into a flat InfraIR.
 *
 * Walks all scopes (root and children), collects providers and resources,
 * serializes specs (replacing RefTokens with RefTokenIR), and produces
 * a single flat IR that the engine can execute.
 */
export function compileToIR(scope: InfraScope): InfraIR {
  const providers = collectProviders(scope);
  const resources = collectResources(scope);

  return Object.freeze({
    name: scope.name,
    providers: Object.freeze(providers),
    resources: Object.freeze(resources),
  });
}

// ─── Provider collection ─────────────────────────────────────────────────────

function collectProviders(scope: InfraScope): ProviderInstanceIR[] {
  const providers: ProviderInstanceIR[] = [];

  for (const [key, registration] of scope.providers) {
    providers.push(
      Object.freeze({
        key,
        adapterName: registration.adapterName,
        config: Object.freeze({ ...registration.config }),
      }),
    );
  }

  for (const child of scope.children) {
    providers.push(...collectProviders(child));
  }

  return providers;
}

// ─── Resource collection ─────────────────────────────────────────────────────

function collectResources(scope: InfraScope): ResourceIR[] {
  const resources: ResourceIR[] = [];

  for (const handle of scope.resources) {
    resources.push(compileHandle(handle));
  }

  for (const child of scope.children) {
    resources.push(...collectResources(child));
  }

  for (const fragment of scope.fragments) {
    for (const raw of fragment.resources) {
      resources.push(compileDeclarativeResource(raw));
    }
  }

  return resources;
}

// ─── Handle compilation ──────────────────────────────────────────────────────

function compileHandle(handle: ResourceHandle): ResourceIR {
  const serializedSpec = serializeSpec(handle.rawSpec);
  const dependsOn = Array.from(handle.explicitDeps, (dep) => dep.name);

  return Object.freeze({
    name: handle.name,
    provider: handle.provider,
    kind: handle.kind,
    mode: handle.mode,
    spec: serializedSpec,
    dependsOn: Object.freeze(dependsOn),
    refBindings: Object.freeze([...handle.refBindings]),
  });
}

// ─── Declarative resource compilation ────────────────────────────────────────

interface DeclarativeResourceEntry {
  readonly provider: string;
  readonly kind: string;
  readonly name: string;
  readonly mode?: "manage" | "read";
  readonly dependsOn?: readonly string[];
  readonly [key: string]: unknown;
}

function compileDeclarativeResource(raw: DeclarativeResourceEntry): ResourceIR {
  const {
    provider,
    kind,
    name,
    mode,
    dependsOn: rawDependsOn,
    ...specFields
  } = raw;

  const refBindings = extractRefBindingsFromUnknown(specFields);
  const serializedSpec = serializeSpec(specFields);
  const dependsOn = Array.isArray(rawDependsOn)
    ? rawDependsOn.map((d) => String(d))
    : [];

  return Object.freeze({
    name,
    provider,
    kind,
    mode: mode ?? "manage",
    spec: serializedSpec,
    dependsOn: Object.freeze(dependsOn),
    refBindings: Object.freeze(refBindings),
  });
}

// ─── Spec serialization ──────────────────────────────────────────────────────

/**
 * Deep-walk a spec and replace every RefToken with its serialisable RefTokenIR form.
 * All other values pass through unchanged.
 */
function serializeSpec(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    result[key] = serializeValue(value);
  }
  return result;
}

function serializeValue(value: unknown): unknown {
  if (isRefToken(value)) return refTokenToIR(value);
  if (Array.isArray(value)) return value.map(serializeValue);
  if (isRecord(value)) return serializeSpec(value);
  return value;
}

// ─── Ref extraction for declarative resources ────────────────────────────────

function extractRefBindingsFromUnknown(
  spec: unknown,
  pathPrefix = "",
): RefBindingIR[] {
  if (Array.isArray(spec)) {
    const bindings: RefBindingIR[] = [];
    for (let i = 0; i < spec.length; i++) {
      const currentPath = `${pathPrefix}[${String(i)}]`;
      bindings.push(...extractRefBindingsFromUnknown(spec[i], currentPath));
    }
    return bindings;
  }

  if (!isRecord(spec)) return [];

  const bindings: RefBindingIR[] = [];
  for (const [key, value] of Object.entries(spec)) {
    const currentPath = pathPrefix.length > 0 ? `${pathPrefix}.${key}` : key;
    if (isRefToken(value)) {
      bindings.push({
        specPath: currentPath,
        targetResource: value.resource,
        statePath: value.path,
      });
    } else {
      bindings.push(...extractRefBindingsFromUnknown(value, currentPath));
    }
  }
  return bindings;
}
