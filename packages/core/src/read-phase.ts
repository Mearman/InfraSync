/**
 * Phase 1: Read current state for all resources.
 *
 * Connects providers, builds the resource DAG, reads current state for each
 * resource in dependency order, resolves symbolic refs, validates adapter
 * output through state schemas.
 *
 * Non-deterministic: queries external provider APIs.
 * Output (StateMap) is a snapshot of reality at a point in time.
 */
import type { InfraIR, ResourceIR } from "./types.js";
import {
  ResolvedScopes,
  type ProviderAdapter,
  type ProviderPort,
  type OrphanedResource,
} from "./provider.js";
import type { ResourceIssue } from "./resource.js";
import {
  collectZodIssues,
  deepEqual,
  isRecord,
  resolveConfigSecrets,
  resolveScopes,
  envSecretResolver,
} from "./resource.js";
import type { SecretResolver } from "./resource.js";
import { ProviderApiError } from "./errors.js";
import type { ResourceCache } from "./cache.js";
import { CachedProviderPort } from "./cache.js";
import { StateMap } from "./state-map.js";
import { buildDag, topologicalSortByLevel } from "./dag.js";
import type { DagNode } from "./dag.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Options for orphan detection during the read phase. */
export interface OrphanDetectionOptions {
  /** Enable orphan detection by calling list() on handlers that implement it. */
  readonly enabled: boolean;
}

export interface ReadPhaseInput {
  readonly ir: InfraIR;
  readonly adapters: Map<string, ProviderAdapter>;
  readonly secretResolver?: SecretResolver;
  readonly cache?: ResourceCache;
  readonly cacheTtl?: number;
  readonly orphanDetection?: OrphanDetectionOptions;
}

export interface ReadPhaseOutput {
  readonly stateMap: StateMap;
  readonly instances: Map<string, ProviderPort>;
  readonly configs: Map<string, Record<string, unknown>>;
  readonly issues: readonly ResourceIssue[];
  readonly orphans?: readonly OrphanedResource[];
}

// ─── Read phase ──────────────────────────────────────────────────────────────

/**
 * Phase 1: Read current state for all resources.
 *
 * - Connects providers (resolves secrets, validates config).
 * - Builds the resource DAG (topological sort).
 * - Reads current state for each resource in dependency order.
 * - Resolves symbolic refs using the state map.
 * - Validates adapter output through stateSchema.
 *
 * Non-deterministic: queries external provider APIs.
 * Output is a snapshot of reality at this point in time.
 */
export async function readPhase(
  input: ReadPhaseInput,
): Promise<ReadPhaseOutput> {
  const { ir, adapters } = input;
  const issues: ResourceIssue[] = [];
  const instances = new Map<string, ProviderPort>();
  const configs = new Map<string, Record<string, unknown>>();
  const secretResolver = input.secretResolver ?? envSecretResolver;

  // 1. Connect providers
  await connectProviders(
    ir,
    adapters,
    instances,
    configs,
    issues,
    secretResolver,
    input.cache,
    input.cacheTtl,
  );
  if (issues.length > 0) {
    return { stateMap: new StateMap(), instances, configs, issues };
  }

  // 2. Build DAG and topological sort
  const dag = buildDag(ir.resources);
  const levels = topologicalSortByLevel(dag);

  // 3. Read state for each resource in dependency order
  const stateMap = new StateMap();

  for (const level of levels) {
    await Promise.all(
      level.map((node) => readNode(node, instances, configs, stateMap, issues)),
    );
  }

  // 4. Detect orphans if requested
  const orphans = await detectOrphans(ir, instances, input.orphanDetection);

  if (orphans !== undefined) {
    return { stateMap, instances, configs, issues, orphans };
  }

  return { stateMap, instances, configs, issues };
}

// ─── Orphan detection ─────────────────────────────────────────────────────────

/**
 * Detect orphaned resources — resources in the provider that are not
 * present in the IR.
 *
 * For each provider instance, iterates all supported kinds. For each kind
 * whose handler implements `list()`, calls it and compares the results
 * against the IR's resources. Resources in the provider that don't match
 * any IR resource are orphans.
 *
 * Matching uses the identity schema: a listed resource matches an IR
 * resource if the identity fields parsed from the listed resource's
 * identity equal those parsed from the IR resource's spec.
 */
async function detectOrphans(
  ir: InfraIR,
  instances: Map<string, ProviderPort>,
  options: OrphanDetectionOptions | undefined,
): Promise<OrphanedResource[] | undefined> {
  if (!options?.enabled) return undefined;

  const orphans: OrphanedResource[] = [];

  // Group IR resources by (provider, kind) for fast lookup
  const irResourcesByProviderKind = new Map<string, ResourceIR[]>();
  for (const resource of ir.resources) {
    const key = `${resource.provider}::${resource.kind}`;
    const existing = irResourcesByProviderKind.get(key);
    if (existing !== undefined) {
      existing.push(resource);
    } else {
      irResourcesByProviderKind.set(key, [resource]);
    }
  }

  for (const [providerKey, providerInstance] of instances) {
    for (const kind of providerInstance.supportedKinds()) {
      const handler = providerInstance.resourceHandler(
        kind,
        ResolvedScopes.empty,
      );

      // Skip handlers that don't implement list()
      if (handler.list === undefined) continue;

      const listed = await handler.list();

      // Get IR resources for this provider+kind combination
      const mapKey = `${providerKey}::${kind}`;
      const irResources = irResourcesByProviderKind.get(mapKey) ?? [];

      for (const listedResource of listed) {
        const isOrphan = !irResources.some((irResource) => {
          // Parse the IR resource's spec through the identity schema
          // to get comparable identity fields
          const specWithMeta = {
            ...irResource.spec,
            kind: irResource.kind,
            name: irResource.name,
          };
          const identityResult = handler.identitySchema
            .loose()
            .safeParse(specWithMeta);
          if (!identityResult.success) return false;

          // Compare identity fields between the listed resource and the IR resource
          const listedIdResult = handler.identitySchema.safeParse(
            listedResource.identity,
          );
          if (!listedIdResult.success) return false;

          return deepEqual(identityResult.data, listedIdResult.data);
        });

        if (isOrphan) {
          orphans.push({
            kind,
            stateId: listedResource.stateId,
            identity: listedResource.identity,
            state: listedResource.state,
          });
        }
      }
    }
  }

  return orphans;
}

// ─── Provider connection ─────────────────────────────────────────────────────

async function connectProviders(
  ir: InfraIR,
  adapters: Map<string, ProviderAdapter>,
  instances: Map<string, ProviderPort>,
  configs: Map<string, Record<string, unknown>>,
  issues: ResourceIssue[],
  secretResolver: SecretResolver,
  cache: ResourceCache | undefined,
  cacheTtl: number | undefined,
): Promise<void> {
  for (const provider of ir.providers) {
    const adapter = adapters.get(provider.adapterName);
    if (adapter === undefined) {
      issues.push({
        resource: provider.key,
        message: `Unknown adapter: "${provider.adapterName}" — no adapter registered with that name`,
      });
      continue;
    }

    const instance = adapter.create();
    const resolvedConfig = resolveConfigSecrets(
      provider.config,
      secretResolver,
    );

    const result = instance.configSchema.safeParse(resolvedConfig);
    if (!result.success) {
      issues.push(
        ...collectZodIssues(`provider:${provider.key}`, result.error),
      );
      continue;
    }

    await instance.connect(resolvedConfig);

    // Wrap with cache if configured
    const maybeCached =
      cache !== undefined
        ? new CachedProviderPort(
            instance,
            cache,
            cacheTtl !== undefined ? { ttl: cacheTtl } : undefined,
          )
        : instance;

    instances.set(provider.key, maybeCached);
    if (isRecord(result.data)) {
      configs.set(provider.key, result.data);
    }
  }
}

/**
 * Disconnect all provider instances. Non-fatal — logs errors.
 */
export async function disconnectProviders(
  instances: Map<string, ProviderPort>,
): Promise<void> {
  const disconnectResults = await Promise.allSettled(
    [...instances.values()].map((instance) => instance.disconnect()),
  );

  for (const result of disconnectResults) {
    if (result.status === "rejected") {
      console.error("Failed to disconnect provider:", result.reason);
    }
  }
}

// ─── Per-node read ───────────────────────────────────────────────────────────

async function readNode(
  node: DagNode,
  instances: Map<string, ProviderPort>,
  configs: Map<string, Record<string, unknown>>,
  stateMap: StateMap,
  issues: ResourceIssue[],
): Promise<void> {
  const { resource } = node;

  // Look up provider instance
  const provider = instances.get(resource.provider);
  if (provider === undefined) {
    issues.push({
      resource: resource.name,
      message: `Provider instance "${resource.provider}" not connected`,
    });
    stateMap.setRaw(resource.name, undefined);
    return;
  }

  // Look up resource handler — first get the prototype to read scope declarations
  const handlerPrototype = provider.resourceHandler(
    resource.kind,
    ResolvedScopes.empty,
  );

  // 1. Resolve refs in the compiled spec
  // NOTE: Ref resolution in the read phase is best-effort only.
  // Resources that reference not-yet-created resources will have unresolved refs.
  // The executor resolves refs at execution time when all deps have been created.
  // For the read phase, we just inject identity fields.
  let resolvedSpec: unknown = resource.spec;

  // 1b. Inject identity fields from the IR into the spec.
  if (isRecord(resolvedSpec)) {
    if (!("kind" in resolvedSpec)) resolvedSpec.kind = resource.kind;
    if (!("name" in resolvedSpec)) resolvedSpec.name = resource.name;
  } else {
    resolvedSpec = { kind: resource.kind, name: resource.name };
  }

  // 2. Validate only identity fields for the read phase.
  // Full spec validation happens in the plan phase (for convergence check)
  // and execute phase (after ref resolution). During read, we only need
  // identity to look up existing resources.
  //
  // Identity schemas may be strict objects that reject extra fields, so we
  // validate with passthrough to allow the full spec through.
  const identityResult = handlerPrototype.identitySchema
    .loose()
    .safeParse(resolvedSpec);
  if (!identityResult.success) {
    issues.push(...collectZodIssues(resource.name, identityResult.error));
    stateMap.setRaw(resource.name, undefined);
    return;
  }

  // 2b. Resolve scopes and create the real handler with them injected
  const providerConfig = configs.get(resource.provider);
  const scopes = resolveScopes(
    handlerPrototype.scopes,
    resolvedSpec,
    providerConfig,
  );
  const handler = provider.resourceHandler(resource.kind, scopes);

  // 3. Read current state from the provider
  let state: unknown;
  try {
    state = await handler.read(resolvedSpec);
  } catch (err) {
    if (err instanceof ProviderApiError) {
      issues.push(
        ...err.issues.map((issue) => ({
          resource: resource.name,
          message: `${issue.path.map(String).join(".")}: ${issue.message}`,
        })),
      );
      stateMap.setRaw(resource.name, undefined);
      return;
    }
    throw err;
  }

  // 4. Validate adapter output through state schema and store
  if (state !== undefined) {
    const stateResult = handler.stateSchema.safeParse(state);
    if (!stateResult.success) {
      issues.push(...collectZodIssues(resource.name, stateResult.error));
      stateMap.setRaw(resource.name, undefined);
      return;
    }
    state = stateResult.data;
  }

  stateMap.setRaw(resource.name, state);
}
