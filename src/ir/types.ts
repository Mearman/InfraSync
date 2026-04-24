/**
 * Canonical intermediate representation for InfraSync.
 *
 * All authoring forms (functional scopes, declarative fragments) compile to
 * this flat, serialisable format. The engine only ever consumes InfraIR —
 * never live authoring objects, Proxies, or closures.
 *
 * Design constraint: every type in this module must be JSON-serialisable.
 * No Maps, Symbols, functions, or class instances.
 */

// ─── Refs and secrets ────────────────────────────────────────────────────────

/** A symbolic reference from one resource's spec to another resource's state. */
export interface RefTokenIR {
  readonly $ref: {
    readonly resource: string;
    readonly path: string;
  };
}

/**
 * A binding between a spec field path and the state field it references.
 * Collected during compilation so the engine can resolve refs at execution time.
 */
export interface RefBindingIR {
  /** Dot-notation path within the resource spec (e.g. "value", "policy.Resource") */
  readonly specPath: string;
  /** The resource name this ref targets */
  readonly targetResource: string;
  /** Dot-notation path within the target resource's state (e.g. "websiteEndpoint") */
  readonly statePath: string;
}

/**
 * A serialisable descriptor for a secret value.
 * Not the secret itself — just instructions for where to find it at execution time.
 */
export interface SecretSourceIR {
  readonly $secret: {
    readonly kind: "env";
    readonly name: string;
  };
}

// ─── Providers ───────────────────────────────────────────────────────────────

/** A provider instance as it appears in compiled InfraIR. */
export interface ProviderInstanceIR {
  /** Unique instance key within the configuration (e.g. "awsProd", "cfCompany") */
  readonly key: string;
  /** The adapter name this instance uses (e.g. "cloudflare", "aws") */
  readonly adapterName: string;
  /** Raw config object — may contain SecretSourceIR values to be resolved at execution time */
  readonly config: Readonly<Record<string, unknown>>;
}

// ─── Resources ───────────────────────────────────────────────────────────────

/** A single resource as it appears in compiled InfraIR. */
export interface ResourceIR {
  /** Unique name within the configuration — the DAG node key */
  readonly name: string;
  /** Provider instance key this resource is routed to */
  readonly provider: string;
  /** Resource kind within that provider (e.g. "DnsRecord", "S3Bucket") */
  readonly kind: string;
  /** Whether the engine manages this resource or just reads it */
  readonly mode: "manage" | "read";
  /** Raw spec — may contain RefTokenIR or SecretSourceIR values */
  readonly spec: Readonly<Record<string, unknown>>;
  /** Explicit dependency edges by resource name */
  readonly dependsOn: readonly string[];
  /** Symbolic ref bindings extracted from the spec at compile time */
  readonly refBindings: readonly RefBindingIR[];
}

// ─── Top-level ───────────────────────────────────────────────────────────────

/** The canonical, flat intermediate representation the engine consumes. */
export interface InfraIR {
  readonly name: string;
  readonly providers: readonly ProviderInstanceIR[];
  readonly resources: readonly ResourceIR[];
}
