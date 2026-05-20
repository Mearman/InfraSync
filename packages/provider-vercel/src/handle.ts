import type {
  ResourceHandle,
  ResourceOptions,
  RefBuilder,
} from "@infrasync-org/core/handles";
import { createResourceHandle } from "@infrasync-org/core/handles";
import type { ProjectRefs } from "./project.js";
import { buildProjectRefs } from "./project.js";
import type { ProjectDomainRefs } from "./project-domain.js";
import { buildProjectDomainRefs } from "./project-domain.js";
import type { EnvironmentVariableRefs } from "./environment-variable.js";
import { buildEnvironmentVariableRefs } from "./environment-variable.js";
import type { DomainRefs } from "./domain.js";
import { buildDomainRefs } from "./domain.js";
import type { ProjectSpec } from "./project.js";
import type { ProjectDomainSpec } from "./project-domain.js";
import type { EnvironmentVariableSpec } from "./environment-variable.js";
import type { DomainSpec } from "./domain.js";

// ─── Registration function ───────────────────────────────────────────────────

export type ResourceRegistrar = (
  handle: ResourceHandle<unknown, unknown>,
) => void;

// ─── Typed Vercel handle ─────────────────────────────────────────────────────

/**
 * A typed provider handle for Vercel resources.
 *
 * Created by `createVercelHandle()`. Each method returns a
 * `ResourceHandle` with the correct spec type and typed ref surface.
 *
 * Usage:
 *
 * ```typescript
 * const infra = defineInfra("prod", (infra) => {
 *   const vc = infra.provider("vc", vercel, { ... });
 *   const vcTyped = createVercelHandle(vc.instanceKey, vc.adapterName, vc.register);
 *
 *   const project = vcTyped.project("my-app", {
 *     kind: "Project",
 *     name: "my-app",
 *     framework: "nextjs",
 *   });
 *   project.ref.id; // RefToken — typed
 * });
 * ```
 */
export interface VercelProviderHandle {
  readonly instanceKey: string;
  readonly adapterName: string;

  project(
    id: string,
    spec: ProjectSpec,
    options?: ResourceOptions,
  ): ResourceHandle<ProjectSpec, ProjectRefs>;

  projectDomain(
    id: string,
    spec: ProjectDomainSpec,
    options?: ResourceOptions,
  ): ResourceHandle<ProjectDomainSpec, ProjectDomainRefs>;

  environmentVariable(
    id: string,
    spec: EnvironmentVariableSpec,
    options?: ResourceOptions,
  ): ResourceHandle<EnvironmentVariableSpec, EnvironmentVariableRefs>;

  domain(
    id: string,
    spec: DomainSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DomainSpec, DomainRefs>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class VercelProviderHandleImpl implements VercelProviderHandle {
  constructor(
    readonly instanceKey: string,
    readonly adapterName: string,
    private readonly registerResource: ResourceRegistrar,
  ) {}

  project(
    id: string,
    spec: ProjectSpec,
    options?: ResourceOptions,
  ): ResourceHandle<ProjectSpec, ProjectRefs> {
    return this.typedResource("Project", id, spec, options, buildProjectRefs);
  }

  projectDomain(
    id: string,
    spec: ProjectDomainSpec,
    options?: ResourceOptions,
  ): ResourceHandle<ProjectDomainSpec, ProjectDomainRefs> {
    return this.typedResource(
      "ProjectDomain",
      id,
      spec,
      options,
      buildProjectDomainRefs,
    );
  }

  environmentVariable(
    id: string,
    spec: EnvironmentVariableSpec,
    options?: ResourceOptions,
  ): ResourceHandle<EnvironmentVariableSpec, EnvironmentVariableRefs> {
    return this.typedResource(
      "EnvironmentVariable",
      id,
      spec,
      options,
      buildEnvironmentVariableRefs,
    );
  }

  domain(
    id: string,
    spec: DomainSpec,
    options?: ResourceOptions,
  ): ResourceHandle<DomainSpec, DomainRefs> {
    return this.typedResource("Domain", id, spec, options, buildDomainRefs);
  }

  private typedResource<TSpec, TRefs>(
    kind: string,
    id: string,
    spec: TSpec,
    options: ResourceOptions | undefined,
    buildRefs: RefBuilder<TRefs>,
  ): ResourceHandle<TSpec, TRefs> {
    const handle = createResourceHandle(
      id,
      this.instanceKey,
      kind,
      spec,
      options,
      buildRefs,
    );
    this.registerResource(handle);
    return handle;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a typed Vercel provider handle.
 *
 * Usage:
 *
 * ```typescript
 * import { vercel, createVercelHandle } from "@infrasync-org/vercel";
 *
 * const infra = defineInfra("prod", (infra) => {
 *   const baseVc = infra.provider("vc", vercel, { ... });
 *   const vc = createVercelHandle(
 *     baseVc.instanceKey,
 *     baseVc.adapterName,
 *     baseVc.register,
 *   );
 *
 *   const project = vc.project("my-app", {
 *     kind: "Project",
 *     name: "my-app",
 *     framework: "nextjs",
 *   });
 * });
 * ```
 */
export function createVercelHandle(
  instanceKey: string,
  adapterName: string,
  registerResource: ResourceRegistrar,
): VercelProviderHandle {
  return new VercelProviderHandleImpl(
    instanceKey,
    adapterName,
    registerResource,
  );
}
