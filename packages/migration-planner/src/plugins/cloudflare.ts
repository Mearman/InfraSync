/**
 * Cloudflare migration plugin — provider-specific safety rules.
 *
 * Knows which Cloudflare resource attribute changes are safe, risky,
 * or destructive (requiring delete + recreate).
 */
import type { MigrationPlugin } from "../schemas.js";

export const cloudflarePlugin: MigrationPlugin = {
  name: "cloudflare",
  adapterName: "cloudflare",
  resourceMappings: [
    { tfType: "cloudflare_record", infraKind: "CloudflareRecord" },
    { tfType: "cloudflare_zone", infraKind: "CloudflareZone" },
    { tfType: "cloudflare_page_rule", infraKind: "CloudflarePageRule" },
    { tfType: "cloudflare_worker_script", infraKind: "CloudflareWorkerScript" },
    { tfType: "cloudflare_worker_route", infraKind: "CloudflareWorkerRoute" },
    { tfType: "cloudflare_dns_record", infraKind: "CloudflareDnsRecord" },
  ],
  safetyRules: [
    // cloudflare_record: type change → destructive
    {
      path: "spec.type",
      pathIsRegex: false,
      actions: ["update"],
      direction: "both",
      severity: "destructive",
      description:
        "Changing DNS record type is destructive — requires delete + recreate",
    },
    // cloudflare_record: zone_id change → destructive
    {
      path: "spec.zone_id",
      pathIsRegex: false,
      actions: ["update"],
      direction: "both",
      severity: "destructive",
      description:
        "Changing zone_id is destructive — resource belongs to a different zone",
    },
    // cloudflare_record: name change → destructive
    {
      path: "spec.name",
      pathIsRegex: false,
      actions: ["update"],
      direction: "both",
      severity: "destructive",
      description:
        "Changing record name is destructive — different DNS record entirely",
    },
    // cloudflare_record: value change → risky
    {
      path: "spec.value",
      pathIsRegex: false,
      actions: ["update"],
      direction: "both",
      severity: "risky",
      description: "Changing record value affects live traffic — risky",
    },
    // cloudflare_record: ttl change → safe
    {
      path: "spec.ttl",
      pathIsRegex: false,
      actions: ["update"],
      direction: "both",
      severity: "safe",
      description: "TTL changes are safe",
    },
    // cloudflare_record: proxied toggle → safe
    {
      path: "spec.proxied",
      pathIsRegex: false,
      actions: ["update"],
      direction: "both",
      severity: "safe",
      description: "Proxied toggle is safe",
    },
    // Generic: id changes → destructive
    {
      path: "\\.id$",
      pathIsRegex: true,
      actions: ["update"],
      direction: "both",
      severity: "destructive",
      description: "Identifier changes are destructive",
    },
  ],
  attributeMappers: [],
};
