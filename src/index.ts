// ─── IR types ────────────────────────────────────────────────────────────────
export type {
  InfraIR,
  ProviderInstanceIR,
  ResourceIR,
  RefTokenIR,
  RefBindingIR,
  SecretSourceIR,
} from "./ir/types.js";

// ─── Core errors ─────────────────────────────────────────────────────────────
export { ProviderApiError, DagCycleError } from "./core/errors.js";

// ─── Refs ────────────────────────────────────────────────────────────────────
export { RefToken, isRefToken, refable, refTokenToIR } from "./core/refs.js";

// ─── SDK alignment ───────────────────────────────────────────────────────────
export { assertSdkCoverage } from "./core/assert-sdk.js";

// ─── Provider ports ──────────────────────────────────────────────────────────
export { defineProvider } from "./core/provider.js";
export type {
  ProviderPort,
  ResourcePort,
  ProviderAdapter,
} from "./core/provider.js";

// ─── DAG ─────────────────────────────────────────────────────────────────────
export { buildDag, topologicalSortByLevel } from "./core/dag.js";
export type { DagNode } from "./core/dag.js";

// ─── Resource utilities ──────────────────────────────────────────────────────
export {
  deepEqual,
  resolveRefs,
  resolveConfigSecrets,
  collectZodIssues,
} from "./core/resource.js";
export type { ResourceIssue } from "./core/resource.js";

// ─── Plan ────────────────────────────────────────────────────────────────────
export { computePlan } from "./core/plan.js";
export type { PlanAction, PlanEntry } from "./core/plan.js";

// ─── Sync engine ─────────────────────────────────────────────────────────────
export { SyncEngine } from "./core/sync.js";
export type { SyncOptions, SyncResult, ResourceOutcome } from "./core/sync.js";

// ─── Authoring: handles ──────────────────────────────────────────────────────
export { buildGenericRefs } from "./authoring/handles.js";
export type {
  ResourceHandle,
  ProviderHandle,
  ResourceOptions,
  RefBuilder,
  GenericRefs,
} from "./authoring/handles.js";

// ─── Authoring: infra ────────────────────────────────────────────────────────
export { InfraScope } from "./authoring/infra.js";
export type {
  SecretHelper,
  DeclarativeResource,
  DeclarativeFragment,
  ProviderRegistration,
} from "./authoring/infra.js";

// ─── Authoring: declarative ──────────────────────────────────────────────────
export { declarative } from "./authoring/declarative.js";

// ─── Authoring: compiler ─────────────────────────────────────────────────────
export { defineInfra, compileToIR } from "./authoring/compiler.js";
export type { InfraResult } from "./authoring/compiler.js";

// ─── Normalised schemas ──────────────────────────────────────────────────────
export {
  dnsRecordSpecSchema,
  dnsRecordIdentitySchema,
  dnsRecordDesiredStateSchema,
} from "./core/schemas/dns-record.js";
export type { DnsRecordSpec } from "./core/schemas/dns-record.js";

// ─── Cloudflare provider ─────────────────────────────────────────────────────
export {
  CloudflareProvider,
  cloudflareConfigSchema,
  cloudflare,
} from "./providers/cloudflare/index.js";
export { createCloudflareHandle } from "./providers/cloudflare/handle.js";
export type {
  CloudflareProviderHandle,
  ResourceRegistrar,
} from "./providers/cloudflare/handle.js";
export type { CloudflareConfig } from "./providers/cloudflare/index.js";
export { buildDnsRecordRefs } from "./providers/cloudflare/dns-record.js";
export type { DnsRecordRefs } from "./providers/cloudflare/dns-record.js";
export { buildAccessApplicationRefs } from "./providers/cloudflare/access-app.js";
export type { AccessApplicationRefs } from "./providers/cloudflare/access-app.js";
export { buildAccessPolicyRefs } from "./providers/cloudflare/access-policy.js";
export type { AccessPolicyRefs } from "./providers/cloudflare/access-policy.js";
export { buildIdentityProviderRefs } from "./providers/cloudflare/identity-provider.js";
export type { IdentityProviderRefs } from "./providers/cloudflare/identity-provider.js";
export { buildPagesCustomDomainRefs } from "./providers/cloudflare/pages-domain.js";
export type { PagesCustomDomainRefs } from "./providers/cloudflare/pages-domain.js";
