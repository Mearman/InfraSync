/**
 * Cloudflare resource mappers for TF-Config JSON export.
 *
 * Maps InfraSync Cloudflare resource kinds to Terraform resource types
 * with spec field transformations.
 */
import type { ResourceMapper } from "./export-config-json.js";

/**
 * Normalised DNS record spec → Terraform cloudflare_record attributes.
 *
 * InfraSync uses: domain, type, value, ttl, proxied
 * Terraform uses: zone_id, name, type, content, ttl, proxied
 *
 * The spec mapper extracts the zone from the domain. In production,
 * zone_id would come from a zone data source lookup, but for static
 * export we derive it from the domain.
 */
function mapDnsRecordSpec(
  spec: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const domain = spec.domain;
  const type = spec.type;
  const value = spec.value;
  const ttl = spec.ttl;
  const proxied = spec.proxied;

  // Extract zone from domain (last two parts)
  const zone = typeof domain === "string" ? extractZone(domain) : domain;

  return {
    zone_id: zone,
    name: domain,
    type,
    content: value,
    ttl,
    proxied,
  };
}

function extractZone(domain: string): string {
  const parts = domain.split(".");
  return parts.slice(-2).join(".");
}

/**
 * All Cloudflare resource mappers.
 *
 * Usage with exportTfConfigJson:
 * ```typescript
 * import { cloudflareResourceMappers } from "@infrasync-org/adapter-terraform-config-json/cloudflare-mappers";
 *
 * exportTfConfigJson(ir, { resourceMappers: { cloudflare: cloudflareResourceMappers } });
 * ```
 */
export const cloudflareResourceMappers: readonly ResourceMapper[] = [
  {
    kind: "DnsRecord",
    tfType: "cloudflare_record",
    mapSpec: mapDnsRecordSpec,
  },
  {
    kind: "AccessApplication",
    tfType: "cloudflare_access_application",
  },
  {
    kind: "AccessPolicy",
    tfType: "cloudflare_access_policy",
  },
  {
    kind: "IdentityProvider",
    tfType: "cloudflare_access_identity_provider",
  },
  {
    kind: "PagesCustomDomain",
    tfType: "cloudflare_pages_custom_domain",
  },
];
