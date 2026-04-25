import * as z from "zod";
import { refable } from "./refs.js";

// ─── Normalised spec schema ──────────────────────────────────────────────────

/**
 * Normalised DNS record spec — shared across all providers.
 *
 * Users write one spec shape regardless of which provider (Cloudflare, AWS
 * Route53, GCP Cloud DNS) handles the record. Provider-specific quirks are
 * absorbed by codecs.
 */

// Base fields without cross-field validation — used for .pick() sub-schemas.
const dnsRecordBaseSchema = z.object({
  kind: z.literal("DnsRecord"),
  /** Fully qualified domain name (identity field) */
  domain: z.string().trim().min(1),
  /** DNS record type (identity field) */
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]),
  /** Record value — may be a ref to another resource's state */
  value: refable(z.string().trim().min(1)),
  /** Time-to-live in seconds */
  ttl: z.int().min(0).default(300),
  /** Whether the record is proxied through the provider's CDN (Cloudflare-only) */
  proxied: z.boolean().default(false),
});

/**
 * Full DNS record spec with cross-field validation.
 * CNAME records cannot be placed at the zone apex.
 */
export const dnsRecordSpecSchema = dnsRecordBaseSchema.refine(
  (spec) => {
    // CNAME cannot be at zone apex
    if (spec.type === "CNAME") {
      const parts = spec.domain.split(".");
      return spec.domain !== parts.slice(-2).join(".");
    }
    return true;
  },
  {
    message: "CNAME records cannot be placed at the zone apex",
    path: ["type"],
  },
);

export type DnsRecordSpec = z.infer<typeof dnsRecordSpecSchema>;

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

export const dnsRecordIdentitySchema = dnsRecordBaseSchema.pick({
  domain: true,
  type: true,
});

export const dnsRecordDesiredStateSchema = dnsRecordBaseSchema.pick({
  value: true,
  ttl: true,
  proxied: true,
});
