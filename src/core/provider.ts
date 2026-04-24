import { z } from "zod";
import type { ZodType, ZodObject } from "zod";

// ─── ResourcePort ────────────────────────────────────────────────────────────

/**
 * The resource-level port that each resource kind within a provider implements.
 *
 * Spec and state are Zod schemas — the engine validates at every boundary:
 * - specSchema.safeParse() validates user config before any API call
 * - stateSchema.safeParse() validates adapter output before it enters the state map
 *
 * Adapters also validate raw API responses internally against a private
 * apiResponseSchema (not visible here) and throw ProviderApiError on failure.
 *
 * The engine handles convergence generically — it parses both spec and state
 * through desiredStateSchema and compares the results. Adapters don't need
 * their own comparison logic.
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
   * Query the provider API for resources matching the identity fields in spec.
   * Returns undefined if the resource does not exist.
   */
  read(spec: z.infer<TSpecSchema>): Promise<z.infer<TStateSchema> | undefined>;

  /** Create a resource that does not yet exist */
  create(spec: z.infer<TSpecSchema>): Promise<z.infer<TStateSchema>>;

  /** Update an existing resource to match desired state */
  update(
    id: string,
    spec: z.infer<TSpecSchema>,
  ): Promise<z.infer<TStateSchema>>;
}

// ─── ProviderPort ────────────────────────────────────────────────────────────

/**
 * The provider-level port that each provider adapter implements.
 *
 * Manages connection lifecycle and routes resource operations to the correct
 * handler for each resource kind.
 *
 * The engine creates one ProviderPort instance per provider instance entry in
 * InfraIR. Multiple entries with the same adapter type (e.g. "awsProd" and
 * "awsStaging") each get independent adapter instances with separate SDK clients.
 */
export interface ProviderPort<TConfig extends ZodType = ZodType> {
  /** Unique adapter name (e.g. "cloudflare", "aws") */
  readonly name: string;

  /** Zod schema for this provider's configuration (credentials, region, etc.) */
  readonly configSchema: TConfig;

  /** Initialise the provider client — validate credentials, configure SDK */
  connect(config: z.infer<TConfig>): Promise<void>;

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
 *
 * Using a plain object instead of a function with attached properties avoids
 * all type assertions — no Object.defineProperty mutation needed.
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
