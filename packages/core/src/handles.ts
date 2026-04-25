import { RefToken, isRefToken } from "./refs.js";
import type { RefBindingIR } from "./types.js";

// ─── Type guard ──────────────────────────────────────────────────────────────

/**
 * Narrows `unknown` to `Record<string, unknown>`.
 * Used wherever spec objects are iterated generically — replaces
 * `spec as Record<string, unknown>` assertions with a proper type guard.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Ref builder ─────────────────────────────────────────────────────────────

/**
 * A function that constructs the typed ref surface for a resource.
 * Each adapter resource kind provides one — it builds a plain object whose
 * properties are RefToken instances for every referenceable state field.
 *
 * Built-in providers define specific ref types (e.g. S3BucketRefs).
 * Generic providers use `buildGenericRefs` which returns a GenericRefs
 * with a `.ref(path)` method for untyped access.
 *
 * ```typescript
 * // Built-in: typed ref surface with autocomplete
 * interface S3BucketRefs {
 *   readonly arn: RefToken<string>;
 *   readonly websiteEndpoint: RefToken<string>;
 * }
 * const buildS3BucketRefs: RefBuilder<S3BucketRefs> = (name) => ({
 *   arn: new RefToken(name, "arn"),
 *   websiteEndpoint: new RefToken(name, "websiteEndpoint"),
 * });
 * ```
 */
export type RefBuilder<TRefs> = (resourceName: string) => TRefs;

// ─── Generic refs (custom provider fallback) ─────────────────────────────────

/**
 * Fallback ref surface for custom/generic providers.
 * Provides a `.ref(path)` method for untyped string-path access.
 * Built-in providers get typed ref objects with property access instead.
 *
 * ```typescript
 * // Custom provider — no typed ref surface
 * const handle = provider.resource("Service", "api", spec);
 * handle.ref.ref("statusUrl"); // RefToken
 * ```
 */
export interface GenericRefs {
  readonly ref: (path: string) => RefToken;
}

/** Build a GenericRefs for a custom provider resource. */
export const buildGenericRefs: RefBuilder<GenericRefs> = (resourceName) => ({
  ref: (path: string) => new RefToken(resourceName, path),
});

// ─── Resource options ────────────────────────────────────────────────────────

/**
 * Minimal structural type for dependsOn entries.
 * Only requires `name` — avoids variance issues with generic ResourceHandle.
 */
interface Dependable {
  readonly name: string;
}

/** Options that control resource behaviour at authoring time. */
export interface ResourceOptions {
  /** Whether the engine manages this resource or just reads it. Default: "manage" */
  readonly mode?: "manage" | "read";

  /** Explicit dependency edges — resources that must be processed before this one */
  readonly dependsOn?: readonly Dependable[];
}

// ─── ResourceHandle ──────────────────────────────────────────────────────────

/**
 * Internal resource handle created during authoring.
 *
 * `TRefs` is the typed ref surface — a plain object whose properties are
 * RefToken instances for every referenceable state field. Built-in providers
 * define specific ref types (e.g. `S3BucketRefs`); generic providers use
 * `GenericRefs` with a `.ref(path)` fallback method.
 *
 * Not the canonical execution format — these are compilation artefacts the SDK
 * uses before emitting InfraIR.
 */
export interface ResourceHandle<TSpec = unknown, TRefs = GenericRefs> {
  /** Unique name within the configuration — the DAG node key */
  readonly name: string;

  /** Provider instance key (e.g. "awsProd", "cfCompany") */
  readonly provider: string;

  /** Resource kind within that provider (e.g. "DnsRecord", "S3Bucket") */
  readonly kind: string;

  /** Whether the engine manages this resource or just reads it */
  readonly mode: "manage" | "read";

  /** Raw spec — may contain RefToken values */
  readonly rawSpec: TSpec;

  /** Symbolic ref bindings extracted from the spec at construction time */
  readonly refBindings: readonly RefBindingIR[];

  /** Handles listed in dependsOn */
  readonly explicitDeps: ReadonlySet<Dependable>;

  /**
   * Typed ref surface for this resource.
   *
   * Built-in providers expose typed properties:
   * ```typescript
   * bucket.ref.websiteEndpoint // ✅ RefToken<string> — autocomplete, compile-time validated
   * bucket.ref.nonexistent     // ❌ compile error
   * ```
   *
   * Custom providers expose a `.ref(path)` method:
   * ```typescript
   * handle.ref.ref("statusUrl") // RefToken
   * ```
   */
  readonly ref: TRefs;
}

// ─── ResourceHandle implementation ───────────────────────────────────────────

class ResourceHandleImpl<TSpec, TRefs> implements ResourceHandle<TSpec, TRefs> {
  readonly refBindings: readonly RefBindingIR[];
  readonly explicitDeps: ReadonlySet<Dependable>;

  constructor(
    readonly name: string,
    readonly provider: string,
    readonly kind: string,
    readonly mode: "manage" | "read",
    readonly rawSpec: TSpec,
    options: ResourceOptions | undefined,
    readonly ref: TRefs,
  ) {
    this.refBindings = extractRefBindings(rawSpec);
    this.explicitDeps = new Set(options?.dependsOn ?? []);
  }
}

/**
 * Create a resource handle with a typed ref surface.
 *
 * @param name - Unique resource name
 * @param provider - Provider instance key
 * @param kind - Resource kind
 * @param spec - Raw spec (may contain RefToken values)
 * @param options - Mode and dependency declarations
 * @param buildRefs - Ref builder function from the adapter
 */
export function createResourceHandle<TSpec, TRefs>(
  name: string,
  provider: string,
  kind: string,
  spec: TSpec,
  options: ResourceOptions | undefined,
  buildRefs: RefBuilder<TRefs>,
): ResourceHandle<TSpec, TRefs> {
  return new ResourceHandleImpl(
    name,
    provider,
    kind,
    options?.mode ?? "manage",
    spec,
    options,
    buildRefs(name),
  );
}

// ─── Ref extraction ──────────────────────────────────────────────────────────

/**
 * Walk a spec object tree and extract all RefToken bindings.
 * Each binding records the spec field path, target resource name, and state path.
 */
function extractRefBindings(spec: unknown, pathPrefix = ""): RefBindingIR[] {
  if (Array.isArray(spec)) {
    const bindings: RefBindingIR[] = [];
    for (let i = 0; i < spec.length; i++) {
      const currentPath = `${pathPrefix}[${String(i)}]`;
      bindings.push(...extractRefBindings(spec[i], currentPath));
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
      bindings.push(...extractRefBindings(value, currentPath));
    }
  }
  return bindings;
}

// ─── ProviderHandle ──────────────────────────────────────────────────────────

/**
 * Authoring-time handle for a provider instance.
 *
 * Created by `infra.provider()`. Has a generic `.resource()` method for
 * creating resources with `GenericRefs`. Built-in adapters extend this with
 * typed methods like `.s3Bucket()` or `.dnsRecord()` that provide specific
 * ref types — those are layered on when provider modules are implemented.
 */
export interface ProviderHandle {
  /** Provider instance key (e.g. "awsProd", "cfCompany") */
  readonly instanceKey: string;

  /** Adapter name (e.g. "cloudflare", "aws") */
  readonly adapterName: string;

  /**
   * Register a resource handle with the authoring scope.
   * Used by typed provider handle wrappers (e.g. `createCloudflareHandle`)
   * to register typed resources without going through the generic `resource()` method.
   */
  /**
   * Register a resource handle with the authoring scope.
   * Used by typed provider handle wrappers (e.g. `createCloudflareHandle`)
   * to register typed resources without going through the generic `resource()` method.
   */
  readonly register: (handle: ResourceHandle<unknown, unknown>) => void;
  /**
   * Create a resource on this provider instance with generic refs.
   *
   * For custom providers, use this method. For built-in providers, use
   * the typed convenience methods (e.g. `.s3Bucket()`) that return
   * handles with typed ref surfaces.
   *
   * @param kind - Resource kind (e.g. "Service", "CustomResource")
   * @param id - Unique resource name within the configuration
   * @param spec - Resource specification — may contain RefToken values
   * @param options - Mode and explicit dependency declarations
   */
  resource<TSpec>(
    kind: string,
    id: string,
    spec: TSpec,
    options?: ResourceOptions,
  ): ResourceHandle<TSpec>;
}

// ─── ProviderHandle implementation ───────────────────────────────────────────

class ProviderHandleImpl implements ProviderHandle {
  readonly register: (handle: ResourceHandle<unknown, unknown>) => void;

  constructor(
    readonly instanceKey: string,
    readonly adapterName: string,
    registerResource: (handle: ResourceHandle<unknown, unknown>) => void,
  ) {
    this.register = registerResource;
  }

  resource<TSpec>(
    kind: string,
    id: string,
    spec: TSpec,
    options?: ResourceOptions,
  ): ResourceHandle<TSpec> {
    const handle = createResourceHandle(
      id,
      this.instanceKey,
      kind,
      spec,
      options,
      buildGenericRefs,
    );
    this.register(handle);
    return handle;
  }
}

/**
 * Create a provider handle. Called by InfraScope when a provider is registered.
 */
export function createProviderHandle(
  instanceKey: string,
  adapterName: string,
  registerResource: (handle: ResourceHandle<unknown, unknown>) => void,
): ProviderHandle {
  return new ProviderHandleImpl(instanceKey, adapterName, registerResource);
}
