import { RefToken, isRefToken } from "../core/refs.js";
import type { RefBindingIR } from "../ir/types.js";

// ─── Type guard ──────────────────────────────────────────────────────────────

/**
 * Narrows `unknown` to `Record<string, unknown>`.
 * Used wherever spec objects are iterated generically — replaces
 * `spec as Record<string, unknown>` assertions with a proper type guard.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Resource options ────────────────────────────────────────────────────────

/** Options that control resource behaviour at authoring time. */
export interface ResourceOptions {
  /** Whether the engine manages this resource or just reads it. Default: "manage" */
  readonly mode?: "manage" | "read";

  /** Explicit dependency edges — resources that must be processed before this one */
  readonly dependsOn?: readonly ResourceHandle[];
}

// ─── ResourceHandle ──────────────────────────────────────────────────────────

/**
 * Internal resource handle created during authoring.
 *
 * Not the canonical execution format — these are compilation artefacts the SDK
 * uses before emitting InfraIR. The handle carries dependency identity,
 * extracted ref bindings, and explicit dependsOn edges.
 */
export interface ResourceHandle<TSpec = unknown, TState = unknown> {
  /** @internal Phantom type — used by built-in provider method overloads for typed ref accessors */
  readonly _stateType: TState;
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
  readonly explicitDeps: ReadonlySet<ResourceHandle>;

  /**
   * Create a symbolic reference to a field in this resource's state.
   *
   * The returned RefToken carries the path string for the engine to resolve
   * at execution time. For typed handles (built-in providers), overloaded
   * signatures on the provider methods provide compile-time path validation.
   *
   * ```typescript
   * bucket.ref("websiteEndpoint"); // RefToken
   * handle.ref("someField");       // RefToken
   * ```
   */
  ref(path: string): RefToken;
}

// ─── ResourceHandle implementation ───────────────────────────────────────────

class ResourceHandleImpl<TSpec, TState> implements ResourceHandle<
  TSpec,
  TState
> {
  readonly refBindings: readonly RefBindingIR[];
  readonly explicitDeps: ReadonlySet<ResourceHandle>;
  /** @internal Phantom type — satisfies interface, never read at runtime */
  declare readonly _stateType: TState;

  constructor(
    readonly name: string,
    readonly provider: string,
    readonly kind: string,
    readonly mode: "manage" | "read",
    readonly rawSpec: TSpec,
    options: ResourceOptions | undefined,
  ) {
    this.refBindings = extractRefBindings(rawSpec);
    this.explicitDeps = new Set(options?.dependsOn ?? []);
  }

  ref(path: string): RefToken {
    return new RefToken(this.name, path);
  }
}

/**
 * Create a resource handle. Called by ProviderHandle when a resource is defined.
 */
export function createResourceHandle<TSpec, TState>(
  name: string,
  provider: string,
  kind: string,
  spec: TSpec,
  options: ResourceOptions | undefined,
): ResourceHandle<TSpec, TState> {
  return new ResourceHandleImpl(
    name,
    provider,
    kind,
    options?.mode ?? "manage",
    spec,
    options,
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
 * creating resources. Built-in adapters may extend this with typed methods
 * like `.s3Bucket()` or `.dnsRecord()` — those are layered on when specific
 * provider modules are implemented.
 */
export interface ProviderHandle {
  /** Provider instance key (e.g. "awsProd", "cfCompany") */
  readonly instanceKey: string;

  /** Adapter name (e.g. "cloudflare", "aws") */
  readonly adapterName: string;

  /**
   * Create a resource on this provider instance.
   *
   * @param kind - Resource kind (e.g. "S3Bucket", "DnsRecord")
   * @param id - Unique resource name within the configuration
   * @param spec - Resource specification — may contain RefToken values
   * @param options - Mode and explicit dependency declarations
   */
  resource<TSpec, TState = unknown>(
    kind: string,
    id: string,
    spec: TSpec,
    options?: ResourceOptions,
  ): ResourceHandle<TSpec, TState>;
}

// ─── ProviderHandle implementation ───────────────────────────────────────────

class ProviderHandleImpl implements ProviderHandle {
  private readonly registerResource: (handle: ResourceHandle) => void;

  constructor(
    readonly instanceKey: string,
    readonly adapterName: string,
    registerResource: (handle: ResourceHandle) => void,
  ) {
    this.registerResource = registerResource;
  }

  resource<TSpec, TState = unknown>(
    kind: string,
    id: string,
    spec: TSpec,
    options?: ResourceOptions,
  ): ResourceHandle<TSpec, TState> {
    const handle = createResourceHandle<TSpec, TState>(
      id,
      this.instanceKey,
      kind,
      spec,
      options,
    );
    this.registerResource(handle);
    return handle;
  }
}

/**
 * Create a provider handle. Called by InfraScope when a provider is registered.
 */
export function createProviderHandle(
  instanceKey: string,
  adapterName: string,
  registerResource: (handle: ResourceHandle) => void,
): ProviderHandle {
  return new ProviderHandleImpl(instanceKey, adapterName, registerResource);
}
