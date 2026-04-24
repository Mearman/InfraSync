import type { ZodType } from "zod";
import type { SecretSourceIR } from "../ir/types.js";
import type { ProviderAdapter } from "../core/provider.js";
import { createProviderHandle } from "./handles.js";
import type { ProviderHandle, ResourceHandle } from "./handles.js";

// ─── Declarative fragment type ───────────────────────────────────────────────

/**
 * A declarative resource entry within a fragment.
 * The provider field targets a provider instance key. Spec fields may
 * contain RefToken values for cross-resource references.
 */
export interface DeclarativeResource {
  readonly provider: string;
  readonly kind: string;
  readonly name: string;
  readonly mode?: "manage" | "read";
  readonly dependsOn?: readonly string[];
  readonly [key: string]: unknown;
}

/** A declarative fragment, created by the `declarative()` function. */
export interface DeclarativeFragment {
  readonly name: string;
  readonly resources: readonly DeclarativeResource[];
}

// ─── Secret helper ───────────────────────────────────────────────────────────

/**
 * Secret source descriptors — serialisable instructions for where to
 * find secret values at execution time. Not the secrets themselves.
 */
export interface SecretHelper {
  /**
   * Reference an environment variable.
   * Produces a `{ $secret: { kind: "env", name: "VAR" } }` descriptor
   * that the engine resolves before calling `connect()`.
   */
  env(name: string): SecretSourceIR;
}

const secretHelper: SecretHelper = {
  env(name: string): SecretSourceIR {
    return Object.freeze({
      $secret: Object.freeze({ kind: "env", name }),
    });
  },
};

// ─── Provider registration ───────────────────────────────────────────────────

/** Internal provider registration stored on the scope. */
export interface ProviderRegistration {
  readonly adapterName: string;
  readonly config: Readonly<Record<string, unknown>>;
}

// ─── InfraScope ──────────────────────────────────────────────────────────────

/**
 * The authoring scope for defining infrastructure.
 *
 * Created by `defineInfra()` (root) or `infra.infra()` (child).
 * Resources, providers, and declarative fragments are registered on the scope
 * and later compiled to a flat InfraIR.
 */
export class InfraScope {
  readonly providers = new Map<string, ProviderRegistration>();
  readonly resources: ResourceHandle[] = [];
  readonly children: InfraScope[] = [];
  readonly fragments: DeclarativeFragment[] = [];

  constructor(readonly name: string) {}

  /**
   * Register a provider instance.
   *
   * @param key - Unique instance key (e.g. "awsProd", "cfCompany")
   * @param adapter - Adapter descriptor from defineProvider()
   * @param config - Provider config — may contain SecretSourceIR values
   */
  provider<TConfig extends ZodType>(
    key: string,
    adapter: ProviderAdapter<TConfig>,
    config: Record<string, unknown>,
  ): ProviderHandle {
    if (this.providers.has(key)) {
      throw new Error(
        `Provider instance "${key}" is already registered in scope "${this.name}"`,
      );
    }
    this.providers.set(key, {
      adapterName: adapter.adapterName,
      config,
    });
    return createProviderHandle(key, adapter.adapterName, (handle) => {
      this.resources.push(handle);
    });
  }

  /**
   * Create a child scope for logical grouping.
   *
   * The callback receives a new InfraScope. Resources created inside are
   * collected separately and compiled into the same flat InfraIR.
   *
   * If the callback returns `{ outputs: T }`, those outputs are available
   * on the returned object for parent scopes to reference.
   */
  infra<TOutputs>(
    name: string,
    fn: (infra: InfraScope) => { outputs: TOutputs },
  ): { outputs: TOutputs };

  infra(name: string, fn: (infra: InfraScope) => void): void;

  infra<TOutputs>(
    name: string,
    fn: (infra: InfraScope) => { outputs: TOutputs } | void,
  ): { outputs: TOutputs } | void {
    const child = new InfraScope(name);
    const result = fn(child);
    this.children.push(child);

    if (result && "outputs" in result) {
      return { outputs: result.outputs };
    }
  }

  /**
   * Register a declarative fragment.
   * Declarative fragments are first-class authoring units that participate
   * in the same graph, refs, and provider instances as functionally authored infra.
   */
  use(fragment: DeclarativeFragment): void {
    this.fragments.push(fragment);
  }

  /** Secret source descriptors — resolved at execution time */
  readonly secret: SecretHelper = secretHelper;
}
