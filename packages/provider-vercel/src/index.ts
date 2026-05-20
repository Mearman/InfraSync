import { Vercel } from "@vercel/sdk";
import type {
  ProviderPort,
  ResourcePort,
  ProviderAdapter,
  ResolvedScopes,
  ResourceRegistry,
} from "@infrasync-org/core/provider";
import {
  defineProvider,
  ResourceRegistry as Registry,
} from "@infrasync-org/core/provider";
import * as z from "zod";
import { ProjectResource } from "./project.js";
import { ProjectDomainResource } from "./project-domain.js";
import { EnvironmentVariableResource } from "./environment-variable.js";
import { DomainResource } from "./domain.js";

// ─── Config schema ───────────────────────────────────────────────────────────

export const vercelConfigSchema = z.strictObject({
  apiToken: z.string().trim().min(1),
  /** Optional team ID for scoped operations */
  teamId: z.string().trim().min(1).optional(),
});

export type VercelConfig = z.infer<typeof vercelConfigSchema>;

// ─── Adapter descriptor ────────────────────────────────────────────────────

/**
 * The Vercel adapter descriptor. Pass this to `infra.provider()`:
 *
 * ```typescript
 * import { vercel } from "@infrasync-org/vercel";
 *
 * const vc = infra.provider("vc", vercel, {
 *   apiToken: infra.secret.env("VERCEL_API_TOKEN"),
 *   teamId: "your-team-id",
 * });
 * ```
 */
export const vercel: ProviderAdapter<typeof vercelConfigSchema> =
  defineProvider("vercel", () => new VercelProvider());

export class VercelProvider implements ProviderPort<typeof vercelConfigSchema> {
  readonly name = "vercel";
  readonly configSchema = vercelConfigSchema;

  /** Pluggable resource registry for extending Vercel resources. */
  readonly registry: ResourceRegistry = new Registry();

  private client: Vercel | undefined;

  constructor() {
    this.registry.register("Project", () => {
      const client = this.connectedClient();
      return new ProjectResource(client);
    });

    this.registry.register("ProjectDomain", (scopes) => {
      const client = this.connectedClient();
      return new ProjectDomainResource(client, scopes);
    });

    this.registry.register("EnvironmentVariable", (scopes) => {
      const client = this.connectedClient();
      return new EnvironmentVariableResource(client, scopes);
    });

    this.registry.register("Domain", () => {
      const client = this.connectedClient();
      return new DomainResource(client);
    });
  }

  /**
   * Returns the connected Vercel client, or throws if not connected.
   */
  connectedClient(): Vercel {
    if (this.client === undefined) {
      throw new Error("Vercel provider not connected — call connect() first");
    }
    return this.client;
  }

  async connect(config: unknown): Promise<void> {
    const result = vercelConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(
        `Vercel config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      );
    }
    this.client = new Vercel({
      bearerToken: result.data.apiToken,
    });
    await Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.client = undefined;
    await Promise.resolve();
  }

  supportedKinds(): string[] {
    return this.registry.kinds();
  }

  resourceHandler(kind: string, scopes: ResolvedScopes): ResourcePort {
    return this.registry.create(kind, scopes);
  }
}

// Re-export schemas and types for convenience
export {
  projectSpecSchema,
  type ProjectSpec,
  buildProjectRefs,
  type ProjectRefs,
} from "./project.js";
export {
  projectDomainSpecSchema,
  type ProjectDomainSpec,
  buildProjectDomainRefs,
  type ProjectDomainRefs,
} from "./project-domain.js";
export {
  environmentVariableSpecSchema,
  type EnvironmentVariableSpec,
  buildEnvironmentVariableRefs,
  type EnvironmentVariableRefs,
} from "./environment-variable.js";
export {
  domainSpecSchema,
  type DomainSpec,
  buildDomainRefs,
  type DomainRefs,
} from "./domain.js";
