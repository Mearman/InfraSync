import type * as z from "zod";

// ─── Codec interface ─────────────────────────────────────────────────────────

/**
 * A bidirectional codec for mapping between normalised spec fields and
 * provider-specific state fields.
 *
 * - `decode(normalised)` → provider-specific params (before SDK calls)
 * - `encode(providerState)` → normalised form (for convergence checking)
 *
 * All methods accept `unknown` because callers (engine, adapter) operate at
 * boundaries where data is not yet validated. Implementations validate
 * internally using their Zod schemas before delegating to the underlying
 * ZodCodec for the actual field mapping.
 */
export interface ResourceCodec {
  /** Normalise provider state into spec-equivalent form */
  encode(state: unknown): unknown;
  /** Transform resolved spec into provider-specific params */
  decode(spec: unknown): unknown;
}

// ─── Scopes ──────────────────────────────────────────────────────────────────

/**
 * How a scope value is sourced.
 *
 * - `{ config: "accountId" }` — derived from a field in the provider config.
 *   The engine resolves these from the validated config passed to `connect()`.
 *
 * - `{ ref: "applicationId" }` — derived from a refable spec field that has
 *   already been resolved by the engine. The adapter declares which spec
 *   field carries the parent resource ID; the engine extracts it after
 *   ref resolution.
 */
export type ScopeSource =
  | { readonly config: string }
  | { readonly ref: string };

/**
 * Scope declarations on a ResourcePort.
 *
 * Keys are scope names used in adapter code (e.g. `accountId`, `applicationId`).
 * Values describe how the engine resolves each scope.
 *
 * Example:
 * ```typescript
 * readonly scopes = {
 *   accountId: { config: "accountId" },
 *   applicationId: { ref: "applicationId" },
 * };
 * ```
 */
export type ResourceScopes = Readonly<Record<string, ScopeSource>>;

/**
 * Resolved scope values. Created by the engine and passed to
 * `resourceHandler(kind, scopes)` at handler construction time.
 *
 * Access via `.get(name)` which returns `string` (never undefined). The engine
 * guarantees all declared scopes are present — if one is missing, it threw
 * `ScopeError` during resolution before the handler was ever created.
 */
export class ResolvedScopes {
  private readonly entries: ReadonlyMap<string, string>;

  constructor(entries: readonly (readonly [string, string])[]) {
    this.entries = new Map(entries);
    Object.freeze(this);
  }

  /**
   * Get a resolved scope value by name.
   *
   * Returns `string` — never undefined. The engine resolves all declared
   * scopes before creating the handler, so this always succeeds for
   * correctly declared scope names.
   *
   * @throws ScopeError if the scope name was not declared (adapter bug)
   */
  get(name: string): string {
    const value = this.entries.get(name);
    if (value === undefined) {
      throw new ScopeError(
        name,
        { ref: name },
        "resolved scope is missing — this is an engine bug",
      );
    }
    return value;
  }

  /**
   * Create an empty ResolvedScopes for resources that declare no scopes.
   */
  static readonly empty: ResolvedScopes = new ResolvedScopes([]);
}

/**
 * Error thrown when a scope cannot be resolved.
 */
export class ScopeError extends Error {
  constructor(
    public readonly scopeName: string,
    public readonly source: ScopeSource,
    reason: string,
  ) {
    super(`Scope "${scopeName}": ${reason}`);
    this.name = "ScopeError";
  }
}

// ─── ResourcePort ────────────────────────────────────────────────────────────

/**
 * The resource-level port that each resource kind within a provider implements.
 *
 * All method parameters use `unknown` rather than `z.infer<TSchema>`. This is
 * intentional — it solves a contravariance problem. The engine stores adapters
 * in a dynamic registry (Map<string, ProviderAdapter>) and calls methods
 * without knowing the specific schema types at compile time. Each adapter
 * validates its inputs internally using `specSchema.safeParse()` / `stateSchema.safeParse()`,
 * following the same two-boundary validation pattern the engine uses.
 *
 * The generic parameters still carry type information for the schema properties,
 * which is valuable for adapter authors who import and use the schemas directly.
 */
export interface ResourcePort<
  TSpecSchema extends z.ZodType = z.ZodType,
  TStateSchema extends z.ZodType = z.ZodType,
> {
  /** The resource kind this handler manages (e.g. "DnsRecord", "S3Bucket") */
  readonly kind: string;

  /** Zod schema for the desired configuration of this resource */
  readonly specSchema: TSpecSchema;

  /** Zod schema for the current state returned by the provider API */
  readonly stateSchema: TStateSchema;

  /**
   * Sub-schema containing only identity fields.
   * Used by the engine to look up existing resources.
   * Must be a subset of specSchema — use specSchema.pick({ ... }).
   */
  readonly identitySchema: z.ZodObject<Record<string, z.ZodType>>;

  /**
   * Sub-schema containing only desired-state fields.
   * Used by the engine for convergence checking.
   * Must be a subset of specSchema — use specSchema.pick({ ... }).
   */
  readonly desiredStateSchema: z.ZodObject<Record<string, z.ZodType>>;

  /**
   * Extract the provider-assigned ID from a state object.
   * Used by the engine to pass the correct ID to `update()`.
   *
   * Each adapter knows which field in its state schema contains the
   * provider's unique identifier (e.g. Cloudflare's record UUID,
   * AWS's resource ARN).
   */
  getStateId(state: unknown): string;

  /**
   * Optional bidirectional codec for mapping between normalised spec fields
   * and provider-specific state fields.
   *
   * When present, the engine uses `encode()` to normalise provider state
   * before convergence checking — so `desiredStateSchema` comparisons work
   * against normalised data on both sides.
   *
   * Adapters can use `decode()` to transform resolved specs into
   * provider-specific params for SDK calls.
   */
  readonly codec?: ResourceCodec;

  /**
   * Scopes this resource operates within.
   *
   * Declares how each scope is sourced — from provider config or from a
   * refable spec field. The engine resolves all declared scopes before
   * creating the handler via `resourceHandler(kind, scopes)`.
   *
   * Resources that don't need scopes (e.g. DnsRecord which derives its
   * zone at runtime) simply omit this property.
   */
  readonly scopes?: ResourceScopes;

  /**
   * Query the provider API for resources matching the identity fields in spec.
   * Returns undefined if the resource does not exist.
   *
   * Adapters should validate `spec` through `specSchema.safeParse()` internally.
   */
  read(spec: unknown): Promise<unknown>;

  /**
   * Create a resource that does not yet exist.
   *
   * Adapters should validate `spec` through `specSchema.safeParse()` internally.
   */
  create(spec: unknown): Promise<unknown>;

  /**
   * Update an existing resource to match desired state.
   *
   * Adapters should validate `spec` through `specSchema.safeParse()` internally.
   */
  update(id: string, spec: unknown): Promise<unknown>;
}

// ─── ProviderPort ────────────────────────────────────────────────────────────

/**
 * The provider-level port that each provider adapter implements.
 *
 * `connect()` accepts `unknown` rather than `z.infer<TConfig>` to solve a
 * contravariance problem — the engine stores adapters in a dynamic registry
 * and calls methods without compile-time knowledge of specific config types.
 * Each adapter validates config internally using `configSchema.safeParse()`.
 */
export interface ProviderPort<TConfig extends z.ZodType = z.ZodType> {
  /** Unique adapter name (e.g. "cloudflare", "aws") */
  readonly name: string;

  /** Zod schema for this provider's configuration (credentials, region, etc.) */
  readonly configSchema: TConfig;

  /**
   * Initialise the provider client.
   * Adapters should validate `config` through `configSchema.safeParse()` internally.
   */
  connect(config: unknown): Promise<void>;

  /** Gracefully close connections, release resources */
  disconnect(): Promise<void>;

  /** List all resource kinds this provider supports */
  supportedKinds(): string[];

  /**
   * Create a resource handler for the given kind, with resolved scopes.
   *
   * The engine resolves all declared scopes (from config and ref fields)
   * before calling this method. The handler captures scopes at construction
   * time — read/create/update methods have clean signatures with no scopes
   * parameter.
   *
   * For resources that declare no scopes, `scopes` is `ResolvedScopes.empty`.
   */
  resourceHandler(kind: string, scopes: ResolvedScopes): ResourcePort;
}

// ─── ProviderAdapter (plain object, no assertions) ───────────────────────────

/**
 * A provider adapter descriptor — a plain object carrying the adapter name
 * and a factory function. The engine calls `create()` to produce a fresh
 * ProviderPort instance for each provider instance in the configuration.
 */
export interface ProviderAdapter<TConfig extends z.ZodType = z.ZodType> {
  /** Adapter name, available without calling the factory */
  readonly adapterName: string;
  /** Create a fresh ProviderPort instance */
  readonly create: () => ProviderPort<TConfig>;
}

/**
 * Define a provider adapter by name and factory function.
 *
 * Returns a plain `ProviderAdapter` object — no function mutation or
 * type assertions needed.
 *
 * Usage:
 *
 * ```typescript
 * export const cloudflare = defineProvider("cloudflare", () => new CloudflareProvider());
 * export const aws = defineProvider("aws", () => new AwsProvider());
 * ```
 *
 * Multiple instances of the same adapter get independent SDK clients:
 *
 * ```typescript
 * const awsProd = infra.provider("awsProd", aws, { region: "eu-west-1" });
 * const awsStaging = infra.provider("awsStaging", aws, { region: "us-east-1" });
 * ```
 */
export function defineProvider<TConfig extends z.ZodType>(
  adapterName: string,
  factory: () => ProviderPort<TConfig>,
): ProviderAdapter<TConfig> {
  return {
    adapterName,
    create: factory,
  };
}
