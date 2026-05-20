/**
 * Resource matcher — pairs resources between TerraformIR and InfraIR.
 *
 * Uses plugin registry to map TF types to InfraSync kinds,
 * then matches by name.
 */
import type {
  TerraformIR,
  TerraformResourceIR,
} from "@infrasync-org/core-ir/schemas";
import type { ResourceIR } from "@infrasync-org/core/types";
import type { PluginRegistry } from "./plugin-registry.js";
import type { ResourceKey } from "./schemas.js";

export interface MatchedPair {
  tfResource?: TerraformResourceIR;
  infraResource?: ResourceIR;
  tfKey?: ResourceKey;
  infraKey?: ResourceKey;
}

/**
 * Build matched pairs of TF resources and InfraSync resources.
 *
 * Matching strategy:
 * 1. Resolve TF type → InfraSync kind via plugin registry
 * 2. Match by name (TF resource name ↔ InfraSync resource name)
 * 3. Unmatched TF resources → delete candidates
 * 4. Unmatched InfraSync resources → create candidates
 */
export function matchResources(
  tfIR: TerraformIR,
  infraResources: readonly ResourceIR[],
  registry: PluginRegistry,
): MatchedPair[] {
  const pairs: MatchedPair[] = [];
  const matchedInfra = new Set<number>();

  // Index InfraSync resources by (kind, name)
  const infraIndex = new Map<string, { resource: ResourceIR; index: number }>();
  for (let i = 0; i < infraResources.length; i++) {
    const r = infraResources[i];
    if (r === undefined) continue;
    infraIndex.set(`${r.kind}:${r.name}`, { resource: r, index: i });
  }

  // Match TF resources to InfraSync resources
  for (const tfRes of tfIR.resources) {
    const tfType = tfRes.addressParts.type;
    const tfName = tfRes.addressParts.name;
    const adapterName = resolveProviderAdapter(tfRes.provider);

    const infraKind = registry.resolveInfraKind(tfType);

    const tfKey: ResourceKey = {
      name: tfName,
      type: tfType,
      provider: adapterName,
    };

    if (infraKind === undefined) {
      // No mapping known — unresolvable
      pairs.push({ tfResource: tfRes, tfKey });
      continue;
    }

    // Try exact name match
    const match = infraIndex.get(`${infraKind}:${tfName}`);
    if (match !== undefined && !matchedInfra.has(match.index)) {
      matchedInfra.add(match.index);
      pairs.push({
        tfResource: tfRes,
        infraResource: match.resource,
        tfKey,
        infraKey: {
          name: match.resource.name,
          type: match.resource.kind,
          provider: match.resource.provider,
        },
      });
    } else {
      // TF resource with no InfraSync match → delete candidate
      pairs.push({ tfResource: tfRes, tfKey });
    }
  }

  // Add unmatched InfraSync resources → create candidates
  for (let i = 0; i < infraResources.length; i++) {
    if (matchedInfra.has(i)) continue;
    const r = infraResources[i];
    if (r === undefined) continue;
    pairs.push({
      infraResource: r,
      infraKey: {
        name: r.name,
        type: r.kind,
        provider: r.provider,
      },
    });
  }

  return pairs;
}

/**
 * Resolve a TF provider reference to an adapter name.
 */
function resolveProviderAdapter(provider: {
  localName: string;
  fullName?: string | undefined;
  alias?: string | undefined;
}): string {
  // Use fullName to extract adapter name: "registry.terraform.io/hashicorp/aws" → "aws"
  if (provider.fullName?.includes("/") === true) {
    const parts = provider.fullName.split("/");
    const last = parts[parts.length - 1];
    if (last !== undefined) return last;
  }
  // Fall back to local name
  return provider.localName;
}
