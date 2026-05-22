import type * as z from "zod";
import { InfraScope } from "./infra.js";
import type { ProviderAdapter } from "./provider.js";
import type { ProviderHandle, ResourceOptions } from "./handles.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Configuration for defining a role.
 *
 * @typeParam TParams - Shape of the role's parameters (validated by Zod schema)
 * @typeParam TOutputs - Shape of the role's outputs (typically RefTokens)
 */
export interface RoleConfig<TParams, TOutputs> {
  /** Zod schema for the role's parameters — validated at useRole() time */
  readonly params: z.ZodType<TParams>;

  /**
   * Factory function that creates resources within a namespaced scope.
   *
   * Receives an InfraScope where all resource names are automatically prefixed
   * with the role's prefix (e.g. "webApp:appDns"). Returns an outputs object
   * (typically containing RefTokens) for the caller to use.
   */
  readonly create: (
    infra: InfraScope,
    params: TParams,
  ) => { outputs: TOutputs };
}

/**
 * A reusable, parameterised infrastructure unit.
 *
 * Created by `defineRole()`. Used by `useRole()`.
 * Roles are compile-time only — they produce regular InfraIR resources.
 * The runtime engine has no knowledge of roles.
 *
 * @typeParam TParams - Shape of the role's parameters
 * @typeParam TOutputs - Shape of the role's outputs
 */
export interface RoleDefinition<TParams, TOutputs> {
  /** Role name — used as default prefix when no explicit prefix is provided */
  readonly name: string;

  /** Zod schema for the role's parameters */
  readonly paramsSchema: z.ZodType<TParams>;

  /** Factory function that creates resources */
  readonly create: (
    infra: InfraScope,
    params: TParams,
  ) => { outputs: TOutputs };
}

/**
 * Handle returned by useRole() — provides access to the role's outputs.
 *
 * @typeParam TOutputs - Shape of the role's outputs
 */
export interface RoleHandle<TOutputs> {
  /** The role's outputs (typically RefTokens pointing at namespaced resources) */
  readonly outputs: TOutputs;
}

/**
 * Options for useRole().
 */
export interface UseRoleOptions {
  /**
   * Prefix for resource names within this role instance.
   * Resources get names like `${prefix}:${resourceName}`.
   * Defaults to the role name.
   */
  readonly prefix?: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Define a reusable, parameterised infrastructure role.
 *
 * Roles are authoring conveniences — they create regular InfraIR resources
 * that are compiled flat alongside everything else. The runtime engine
 * doesn't know about roles.
 *
 * Usage:
 *
 * ```typescript
 * const webApp = defineRole("webApp", {
 *   params: z.object({ domain: z.string(), zoneId: z.string() }),
 *   create(infra, params) {
 *     const cf = infra.provider("cf", cloudflare, { zoneId: params.zoneId });
 *     const record = cf.resource("DnsRecord", "appDns", { domain: params.domain });
 *     return { outputs: { endpoint: record.ref.ref("hostname") } };
 *   },
 * });
 * ```
 */
export function defineRole<TParams, TOutputs>(
  name: string,
  config: RoleConfig<TParams, TOutputs>,
): RoleDefinition<TParams, TOutputs> {
  return Object.freeze({
    name,
    paramsSchema: config.params,
    create: config.create,
  });
}

/**
 * Use a role within an InfraScope.
 *
 * Validates the params against the role's Zod schema, creates a namespaced
 * child scope, and runs the role's create function. Resources created
 * by the role get prefixed names (e.g. "webApp:appDns") to avoid collisions
 * when the same role is used multiple times.
 *
 * The role scope is registered as a child of the parent scope and compiled
 * flat by the existing compiler — no runtime changes needed.
 *
 * Usage:
 *
 * ```typescript
 * const infra = defineInfra("prod", (infra) => {
 *   const web = useRole(infra, webApp, { domain: "example.com", zoneId: "abc" });
 *   // web.outputs.endpoint is a RefToken pointing at "webApp:appDns"
 *   return { outputs: {} };
 * });
 * ```
 *
 * @param infra - Parent InfraScope to register the role scope on
 * @param role - RoleDefinition created by defineRole()
 * @param params - Parameters validated against the role's Zod schema
 * @param options - Optional prefix override (defaults to role name)
 * @returns RoleHandle with the role's outputs
 * @throws Error if params fail validation against the role's schema
 */
export function useRole<TParams, TOutputs>(
  infra: InfraScope,
  role: RoleDefinition<TParams, TOutputs>,
  params: TParams,
  options?: UseRoleOptions,
): RoleHandle<TOutputs> {
  // Validate params — fail fast at authoring time
  const parsed = role.paramsSchema.safeParse(params);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((issue) => {
        const path = issue.path.map(String).join(".");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new Error(
      `Role "${role.name}" params validation failed: ${messages}`,
    );
  }

  const prefix = options?.prefix ?? role.name;

  // Create a namespaced child scope that prefixes resource names
  const roleScope = new RoleInfraScope(prefix);

  // Run the role's create function with the namespaced scope
  const result = role.create(roleScope, parsed.data);

  // Register the role scope as a child of the parent scope.
  // The existing compiler walks children and compiles flat.
  infra.children.push(roleScope);

  return { outputs: result.outputs };
}

// ─── Internal: namespaced scope ──────────────────────────────────────────────

/**
 * An InfraScope that prefixes all resource names with a namespace.
 *
 * Overrides provider() to return wrapped handles that automatically
 * apply the prefix when resources are created. All other InfraScope
 * behaviour (secret access, fragments, child scopes) is inherited unchanged.
 */
class RoleInfraScope extends InfraScope {
  constructor(private readonly rolePrefix: string) {
    super(`role:${rolePrefix}`);
  }

  override provider<TConfig extends z.ZodType>(
    key: string,
    adapter: ProviderAdapter<TConfig>,
    config: Record<string, unknown>,
  ): ProviderHandle {
    // Register the provider on this scope (same as base class)
    const handle = super.provider(key, adapter, config);

    // Wrap to prefix all resource names created through this handle
    return new PrefixedProviderHandle(handle, this.rolePrefix);
  }
}

// ─── Internal: prefixed provider handle ──────────────────────────────────────

/**
 * A ProviderHandle wrapper that prefixes resource names.
 *
 * Delegates all operations to the inner handle except resource creation,
 * which prefixes the resource ID with `${prefix}:${id}`. This ensures:
 * - Resources get unique names when the same role is used multiple times
 * - RefTokens created by buildGenericRefs point at the prefixed name
 * - Ref bindings in the compiled IR reference the correct namespaced resource
 */
class PrefixedProviderHandle implements ProviderHandle {
  constructor(
    private readonly inner: ProviderHandle,
    private readonly prefix: string,
  ) {}

  get instanceKey(): string {
    return this.inner.instanceKey;
  }

  get adapterName(): string {
    return this.inner.adapterName;
  }

  get register(): ProviderHandle["register"] {
    return this.inner.register;
  }

  resource<TSpec>(
    kind: string,
    id: string,
    spec: TSpec,
    options?: ResourceOptions,
  ) {
    return this.inner.resource(kind, `${this.prefix}:${id}`, spec, options);
  }
}
