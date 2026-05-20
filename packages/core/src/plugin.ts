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
 * import { customResource } from "@infrasync-org/core/plugin";
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
 *     stateSchema: z.json(),
 *     handlers: {
 *       read: async (spec) => {
 *         const response = await fetch(`/api/zones/${spec.zoneId}/domains`);
 *         const data = await response.json();
 *         return data.find((d: { domain: string }) => d.domain === spec.domain);
 *       },
 *       create: async (spec) => {
 *         const response = await fetch(`/api/zones/${spec.zoneId}/domains`, {
 *           method: "POST",
 *           body: JSON.stringify({ domain: spec.domain }),
 *         });
 *         return response.json();
 *       },
 *       update: async (id, spec) => {
 *         const response = await fetch(`/api/domains/${id}`, {
 *           method: "PATCH",
 *           body: JSON.stringify({ domain: spec.domain }),
 *         });
 *         return response.json();
 *       },
 *     },
 *   }),
 * ];
 * ```
 *
 * Plugins integrate into the same DAG and convergence checking as
 * built-in providers. Unlike providers, plugins have no connection
 * lifecycle and no scope declarations — handlers manage their own state.
 */
import * as z from "zod";
import type {
  ResourcePort,
  ProviderPort,
  ProviderAdapter,
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

// ─── Internal ResourcePort wrapper ───────────────────────────────────────────

/**
 * ResourcePort implementation that delegates to custom handlers.
 *
 * Validates spec through the provided Zod schema before passing to handlers.
 */
class PluginResourcePort<
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

// ─── PluginPort — the adapter-facing interface ───────────────────────────────

/**
 * A plugin's adapter-facing port.
 *
 * Unlike ProviderPort, plugins have no connection lifecycle or scope
 * declarations. The adapter wrapper handles the ProviderPort interface
 * by routing to this simpler contract.
 */
export interface PluginPort {
  /** The resource kind this plugin handles */
  readonly kind: string;

  /** Get the ResourcePort for this plugin's resource kind */
  getResourcePort(): ResourcePort;
}

class PluginPortImpl<
  TSpec extends z.ZodType,
  TState extends z.ZodType,
> implements PluginPort {
  readonly kind: string;
  private readonly resourcePort: PluginResourcePort<TSpec, TState>;

  constructor(config: CustomResourceConfig<TSpec, TState>) {
    this.kind = config.kind;
    this.resourcePort = new PluginResourcePort(config);
  }

  getResourcePort(): ResourcePort {
    return this.resourcePort;
  }
}

// ─── Adapter bridge ──────────────────────────────────────────────────────────

/**
 * Minimal ProviderPort implementation that bridges a PluginPort into
 * the engine's provider lifecycle.
 *
 * connect/disconnect are no-ops since plugins manage their own state.
 * resourceHandler routes to the plugin's single ResourcePort.
 */
class PluginAdapterPort implements ProviderPort {
  readonly name: string;
  readonly configSchema = z.object({});
  private readonly port: PluginPort;

  constructor(port: PluginPort) {
    this.name = `plugin:${port.kind}`;
    this.port = port;
  }

  async connect(): Promise<void> {
    // Plugins manage their own connections inside handlers
  }

  async disconnect(): Promise<void> {
    // No-op
  }

  supportedKinds(): string[] {
    return [this.port.kind];
  }

  resourceHandler(kind: string): ResourcePort {
    if (kind !== this.port.kind) {
      throw new Error(
        `Plugin provider "${this.name}" does not support kind "${kind}"`,
      );
    }
    return this.port.getResourcePort();
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
  const port = new PluginPortImpl(config);
  return {
    adapterName: `plugin:${config.kind}`,
    create: () => new PluginAdapterPort(port),
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
