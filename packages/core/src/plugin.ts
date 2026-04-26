/**
 * Plugin system for custom resource handlers.
 *
 * Allows users to register custom resource handlers in their config file
 * without publishing a full adapter package. A plugin provides a single
 * resource kind with read/create/update operations.
 *
 * Usage:
 *
 * ```typescript
 * import { customResource } from "@infrasync/core/plugin";
 * import * as z from "zod";
 *
 * export const plugins = [
 *   customResource({
 *     kind: "CustomDomain",
 *     specSchema: z.object({
 *       kind: z.literal("CustomDomain"),
 *       domain: z.string().min(1),
 *       zoneId: z.string().min(1),
 *     }),
 *     read: async (spec) => {
 *       const response = await fetch(`/api/zones/${spec.zoneId}/domains`);
 *       const data = await response.json();
 *       return data.find((d: { domain: string }) => d.domain === spec.domain);
 *     },
 *     create: async (spec) => {
 *       const response = await fetch(`/api/zones/${spec.zoneId}/domains`, {
 *         method: "POST",
 *         body: JSON.stringify({ domain: spec.domain }),
 *       });
 *       return response.json();
 *     },
 *     update: async (id, spec) => {
 *       const response = await fetch(`/api/domains/${id}`, {
 *         method: "PATCH",
 *         body: JSON.stringify({ domain: spec.domain }),
 *       });
 *       return response.json();
 *     },
 *   }),
 * ];
 * ```
 *
 * The engine discovers plugins from config file exports and integrates
 * them into the same DAG, scope resolution, and convergence checking
 * as built-in providers.
 */
import * as z from "zod";
import {
  ResolvedScopes,
  type ResourcePort,
  type ProviderPort,
  type ProviderAdapter,
} from "./provider.js";

// ─── Plugin types ────────────────────────────────────────────────────────────

/**
 * Handler functions for a custom resource.
 *
 * Each function receives validated spec (after ref resolution) and returns
 * raw state. The engine validates both spec and state through Zod schemas.
 */
export interface CustomResourceHandlers<TSpec extends z.ZodType = z.ZodType> {
  /** Read current state. Returns undefined if resource doesn't exist. */
  readonly read: (spec: z.infer<TSpec>) => Promise<unknown>;

  /** Create a resource. Returns the created state. */
  readonly create: (spec: z.infer<TSpec>) => Promise<unknown>;

  /** Update an existing resource. Returns the updated state. */
  readonly update: (id: string, spec: z.infer<TSpec>) => Promise<unknown>;
}

/**
 * Configuration for a custom resource plugin.
 */
export interface CustomResourceConfig<
  TSpec extends z.ZodType = z.ZodType,
  TState extends z.ZodType = z.ZodType,
> {
  /** Unique resource kind identifier (e.g. "CustomDomain") */
  readonly kind: string;

  /** Zod schema for the desired configuration */
  readonly specSchema: TSpec;

  /** Zod schema for the provider state */
  readonly stateSchema: TState;

  /** Handler functions */
  readonly handlers: CustomResourceHandlers<TSpec>;

  /**
   * Extract the provider-assigned ID from a state object.
   * Defaults to extracting `state.id`.
   */
  readonly getStateId?: (state: unknown) => string;
}

// ─── Internal adapter wrapper ────────────────────────────────────────────────

/**
 * ResourcePort implementation that delegates to custom handlers.
 *
 * Validates spec through the provided Zod schema before passing to handlers.
 * Validates handler return values through the state schema.
 */
class CustomResourcePort<
  TSpec extends z.ZodType,
  TState extends z.ZodType,
> implements ResourcePort<TSpec, TState> {
  readonly kind: string;
  readonly specSchema: TSpec;
  readonly stateSchema: TState;

  /** No identity/desired sub-schemas for plugins — engine uses full spec */
  readonly identitySchema = z.object({});
  readonly desiredStateSchema = z.object({});

  private readonly handlers: CustomResourceHandlers<TSpec>;
  private readonly idExtractor: (state: unknown) => string;

  constructor(config: CustomResourceConfig<TSpec, TState>) {
    this.kind = config.kind;
    this.specSchema = config.specSchema;
    this.stateSchema = config.stateSchema;
    this.handlers = config.handlers;
    this.idExtractor = config.getStateId ?? defaultGetStateId;
  }

  getStateId(state: unknown): string {
    return this.idExtractor(state);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = this.specSchema.safeParse(spec);
    if (!parsed.success) {
      throw new Error(
        `Plugin "${this.kind}" read: spec validation failed — ${formatIssues(parsed.error.issues)}`,
      );
    }
    return this.handlers.read(parsed.data);
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = this.specSchema.safeParse(spec);
    if (!parsed.success) {
      throw new Error(
        `Plugin "${this.kind}" create: spec validation failed — ${formatIssues(parsed.error.issues)}`,
      );
    }
    return this.handlers.create(parsed.data);
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = this.specSchema.safeParse(spec);
    if (!parsed.success) {
      throw new Error(
        `Plugin "${this.kind}" update: spec validation failed — ${formatIssues(parsed.error.issues)}`,
      );
    }
    return this.handlers.update(id, parsed.data);
  }
}

/**
 * ProviderPort implementation that routes to a single custom resource.
 *
 * The config schema is empty (no provider-level config) since plugins
 * manage their own connection state inside their handlers.
 */
class CustomProviderPort<
  TSpec extends z.ZodType,
  TState extends z.ZodType,
> implements ProviderPort {
  readonly name: string;
  readonly configSchema = z.object({});

  private readonly resourcePort: CustomResourcePort<TSpec, TState>;

  constructor(config: CustomResourceConfig<TSpec, TState>) {
    this.name = `plugin:${config.kind}`;
    this.resourcePort = new CustomResourcePort(config);
  }

  async connect(_config: unknown): Promise<void> {
    // Plugins manage their own connections inside handlers
  }

  async disconnect(): Promise<void> {
    // No-op
  }

  supportedKinds(): string[] {
    return [this.resourcePort.kind];
  }

  resourceHandler(kind: string, _scopes: ResolvedScopes): ResourcePort {
    if (kind === this.resourcePort.kind) {
      return this.resourcePort;
    }
    throw new Error(
      `Plugin provider "${this.name}" does not support kind "${kind}"`,
    );
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Define a custom resource plugin.
 *
 * Returns a `ProviderAdapter` that the engine can discover from config
 * file exports and integrate into the normal sync pipeline.
 *
 * The adapter has no provider-level config — plugins manage their own
 * connections inside their handlers (e.g. using environment variables,
 * fetching tokens, etc.).
 */
export function customResource<
  TSpec extends z.ZodType,
  TState extends z.ZodType = z.ZodType,
>(config: CustomResourceConfig<TSpec, TState>): ProviderAdapter {
  const port = new CustomProviderPort(config);
  return {
    adapterName: port.name,
    create: () => new CustomProviderPort(config),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultGetStateId(state: unknown): string {
  if (typeof state === "object" && state !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(state, "id");
    if (descriptor !== undefined && typeof descriptor.value === "string") {
      return descriptor.value;
    }
  }
  throw new Error(
    "Plugin getStateId: state does not have a string 'id' field. Provide a custom getStateId in the plugin config.",
  );
}

function formatIssues(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[],
): string {
  return issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}
