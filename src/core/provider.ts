import type { ZodType, ZodObject } from "zod";

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
  TSpecSchema extends ZodType = ZodType,
  TStateSchema extends ZodType = ZodType,
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
  readonly identitySchema: ZodObject<Record<string, ZodType>>;

  /**
   * Sub-schema containing only desired-state fields.
   * Used by the engine for convergence checking.
   * Must be a subset of specSchema — use specSchema.pick({ ... }).
   */
  readonly desiredStateSchema: ZodObject<Record<string, ZodType>>;

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
export interface ProviderPort<TConfig extends ZodType = ZodType> {
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

  /** Route a resource operation to the correct handler for a given kind */
  resourceHandler(kind: string): ResourcePort;
}

// ─── ProviderAdapter (plain object, no assertions) ───────────────────────────

/**
 * A provider adapter descriptor — a plain object carrying the adapter name
 * and a factory function. The engine calls `create()` to produce a fresh
 * ProviderPort instance for each provider instance in the configuration.
 */
export interface ProviderAdapter<TConfig extends ZodType = ZodType> {
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
export function defineProvider<TConfig extends ZodType>(
  adapterName: string,
  factory: () => ProviderPort<TConfig>,
): ProviderAdapter<TConfig> {
  return {
    adapterName,
    create: factory,
  };
}
