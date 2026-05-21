import type { Client } from "@microsoft/microsoft-graph-client";
import type { ResourcePort } from "@infrasync-org/core/provider";
import { RefToken } from "@infrasync-org/core/refs";
import type { RefBuilder } from "@infrasync-org/core/handles";
import { ProviderApiError } from "@infrasync-org/core/errors";
import * as z from "zod";
import {
  PROVIDER_NAME,
  getStateId,
  isNotFound,
  toProviderApiError,
} from "./helpers.js";

// ─── Ref type ────────────────────────────────────────────────────────────────

export interface DomainFederationConfigurationRefs {
  readonly id: RefToken;
  readonly domain: RefToken;
  readonly issuerUri: RefToken;
}

export const buildDomainFederationConfigurationRefs: RefBuilder<
  DomainFederationConfigurationRefs
> = (resourceName) => ({
  id: new RefToken(resourceName, "id"),
  domain: new RefToken(resourceName, "domain"),
  issuerUri: new RefToken(resourceName, "issuerUri"),
});

// ─── Spec schema ─────────────────────────────────────────────────────────────

export const domainFederationConfigurationSpecSchema = z.strictObject({
  kind: z.literal("DomainFederationConfiguration"),
  name: z.string().trim().min(1).optional(),
  domain: z.string().trim().min(1),
  issuerUri: z.url(),
  displayName: z.string().trim().min(1),
  activeSignInUri: z.url(),
  passiveSignInUri: z.url(),
  metadataExchangeUri: z.url().optional(),
  signOutUri: z.url(),
  signingCertificate: z.string().trim().min(1),
  preferredAuthenticationProtocol: z.enum(["saml", "wsFed"]).default("saml"),
  federatedIdpMfaBehavior: z
    .enum([
      "acceptIfMfaDoneByFederatedIdp",
      "enforceMfaByFederatedIdp",
      "rejectMfaByFederatedIdp",
    ])
    .default("acceptIfMfaDoneByFederatedIdp"),
  promptLoginBehavior: z
    .enum([
      "translateToFreshPasswordAuthentication",
      "nativeSupport",
      "disabled",
    ])
    .default("disabled"),
  isSignedAuthenticationRequestRequired: z.boolean().default(false),
});

export type DomainFederationConfigurationSpec = z.infer<
  typeof domainFederationConfigurationSpecSchema
>;

// ─── State schema ────────────────────────────────────────────────────────────

/**
 * Provider-returned state for an Entra ID internal domain federation
 * configuration.
 *
 * `read()` and `create()` always follow up the collection/POST call with a
 * `GET /domains/{domain}/federationConfiguration/{id}` against the individual
 * resource — that endpoint returns every SAML attribute, so the state and
 * desired-state schemas can require the same fields symmetrically.
 *
 * `metadataExchangeUri` remains optional because the underlying spec marks it
 * optional: an IdP without WS-Trust does not advertise a MEX URI.
 */
const domainFederationConfigurationStateSchema = z
  .looseObject({
    id: z.string().trim().min(1),
    domain: z.string().trim().min(1),
    issuerUri: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    activeSignInUri: z.string().trim().min(1),
    passiveSignInUri: z.string().trim().min(1),
    metadataExchangeUri: z.string().trim().min(1).optional(),
    signOutUri: z.string().trim().min(1),
    signingCertificate: z.string().trim().min(1),
    preferredAuthenticationProtocol: z.string().trim().min(1),
    federatedIdpMfaBehavior: z.string().trim().min(1),
    promptLoginBehavior: z.string().trim().min(1).optional(),
    isSignedAuthenticationRequestRequired: z.boolean().optional(),
  })
  .brand<"EntraIdDomainFederationConfigurationState">()
  .readonly();

// ─── Identity and desired-state sub-schemas ──────────────────────────────────

const identitySchema = domainFederationConfigurationSpecSchema.pick({
  kind: true,
  domain: true,
});

/**
 * Convergence schema — picks only the mutable, diffable SAML fields.
 *
 * `kind` and `domain` are identity fields handled by `identitySchema`; they
 * cannot change between desired and actual without meaning a different
 * resource entirely, so they have no place in the convergence comparison.
 *
 * Rebuilt as a `z.object` (loose) — `domainFederationConfigurationSpecSchema`
 * is a `z.strictObject` so `.pick()` would propagate strict-mode and reject
 * extra fields the engine passes through (e.g. `id`, `domain`) when parsing
 * normalised state. The spread-from-shape idiom changes strictness while
 * preserving each field's exact validator.
 */
const desiredStateSchema = z.object({
  issuerUri: domainFederationConfigurationSpecSchema.shape.issuerUri,
  displayName: domainFederationConfigurationSpecSchema.shape.displayName,
  activeSignInUri:
    domainFederationConfigurationSpecSchema.shape.activeSignInUri,
  passiveSignInUri:
    domainFederationConfigurationSpecSchema.shape.passiveSignInUri,
  metadataExchangeUri:
    domainFederationConfigurationSpecSchema.shape.metadataExchangeUri,
  signOutUri: domainFederationConfigurationSpecSchema.shape.signOutUri,
  signingCertificate:
    domainFederationConfigurationSpecSchema.shape.signingCertificate,
  preferredAuthenticationProtocol:
    domainFederationConfigurationSpecSchema.shape
      .preferredAuthenticationProtocol,
  federatedIdpMfaBehavior:
    domainFederationConfigurationSpecSchema.shape.federatedIdpMfaBehavior,
  promptLoginBehavior:
    domainFederationConfigurationSpecSchema.shape.promptLoginBehavior,
  isSignedAuthenticationRequestRequired:
    domainFederationConfigurationSpecSchema.shape
      .isSignedAuthenticationRequestRequired,
});

// ─── API response validation ─────────────────────────────────────────────────

/**
 * Validates the full `internalDomainFederation` document returned by
 * `GET /domains/{domain}/federationConfiguration/{id}`.
 *
 * Mirrors `domainFederationConfigurationStateSchema` (minus `domain`, which is
 * not echoed by Graph and is attached separately via `attachDomain`). Graph
 * may return additional fields (`@odata.type`, etc.) — `looseObject` admits
 * them without complaint.
 */
const singleResponseSchema = z.looseObject({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  issuerUri: z.string().trim().min(1),
  activeSignInUri: z.string().trim().min(1),
  passiveSignInUri: z.string().trim().min(1),
  metadataExchangeUri: z
    .string()
    .trim()
    .min(1)
    .nullish()
    .transform((v) => v ?? undefined),
  signOutUri: z.string().trim().min(1),
  signingCertificate: z.string().trim().min(1),
  preferredAuthenticationProtocol: z.string().trim().min(1),
  federatedIdpMfaBehavior: z.string().trim().min(1),
  promptLoginBehavior: z
    .string()
    .trim()
    .min(1)
    .nullish()
    .transform((v) => v ?? undefined),
  isSignedAuthenticationRequestRequired: z
    .boolean()
    .nullish()
    .transform((v) => v ?? undefined),
});

/**
 * Validates the collection envelope returned by
 * `GET /domains/{domain}/federationConfiguration`. The collection endpoint
 * returns a `value` array of entries that may not include every SAML field —
 * only `id` is consumed from this layer; the adapter follows up with a GET on
 * the individual configuration to fetch the full document.
 */
const collectionResponseSchema = z.looseObject({
  value: z.array(z.looseObject({ id: z.string().trim().min(1) })),
});

function validateSingle(
  raw: unknown,
  operation: string,
): z.infer<typeof singleResponseSchema> {
  const result = singleResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new ProviderApiError(PROVIDER_NAME, operation, result.error.issues);
  }
  return result.data;
}

function attachDomain(
  raw: z.infer<typeof singleResponseSchema>,
  domain: string,
): Record<string, unknown> {
  const merged = { ...raw, domain };
  // Strip undefined values: deepEqual compares key counts, so
  // { metadataExchangeUri: undefined } ≠ {} and causes false drift when
  // the optional field is absent from the desired spec.
  return Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  );
}

// ─── Request body builder ────────────────────────────────────────────────────

/**
 * Build the body for `POST` and `PATCH` against the federation configuration.
 * Graph requires the `@odata.type` discriminator on create.
 *
 * `domain` is excluded — it is encoded into the URL path, not the body.
 */
function buildBody(
  spec: DomainFederationConfigurationSpec,
  includeOdataType: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    displayName: spec.displayName,
    issuerUri: spec.issuerUri,
    activeSignInUri: spec.activeSignInUri,
    passiveSignInUri: spec.passiveSignInUri,
    signOutUri: spec.signOutUri,
    signingCertificate: spec.signingCertificate,
    preferredAuthenticationProtocol: spec.preferredAuthenticationProtocol,
    federatedIdpMfaBehavior: spec.federatedIdpMfaBehavior,
    promptLoginBehavior: spec.promptLoginBehavior,
    isSignedAuthenticationRequestRequired:
      spec.isSignedAuthenticationRequestRequired,
  };
  if (spec.metadataExchangeUri !== undefined) {
    body.metadataExchangeUri = spec.metadataExchangeUri;
  }
  if (includeOdataType) {
    body["@odata.type"] = "#microsoft.graph.internalDomainFederation";
  }
  return body;
}

// ─── Resource implementation ────────────────────────────────────────────────

export class DomainFederationConfigurationResource implements ResourcePort<
  typeof domainFederationConfigurationSpecSchema,
  typeof domainFederationConfigurationStateSchema
> {
  readonly kind = "DomainFederationConfiguration";
  readonly specSchema = domainFederationConfigurationSpecSchema;
  readonly stateSchema = domainFederationConfigurationStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  constructor(private readonly client: Client) {}

  getStateId = getStateId;

  /**
   * Fetch the full `internalDomainFederation` document for a known id and
   * attach the `domain` (which Graph does not echo) to the returned state.
   *
   * The individual endpoint returns every SAML attribute — convergence and
   * desired-state validation rely on this completeness.
   */
  private async fetchConfiguration(
    domain: string,
    id: string,
    operation: string,
  ): Promise<Record<string, unknown>> {
    const raw: unknown = await this.client
      .api(
        `/domains/${encodeURIComponent(domain)}/federationConfiguration/${encodeURIComponent(id)}`,
      )
      .get();
    const validated = validateSingle(raw, operation);
    return attachDomain(validated, domain);
  }

  async read(spec: unknown): Promise<unknown> {
    const parsed = domainFederationConfigurationSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "read", parsed.error.issues);
    }
    try {
      // The collection endpoint may omit SAML attributes from its entries —
      // it is used purely to discover the configuration id. Once we have the
      // id, the individual GET returns the full document.
      const rawCollection: unknown = await this.client
        .api(
          `/domains/${encodeURIComponent(parsed.data.domain)}/federationConfiguration`,
        )
        .get();
      const collection = collectionResponseSchema.safeParse(rawCollection);
      if (!collection.success) {
        throw new ProviderApiError(
          PROVIDER_NAME,
          "read",
          collection.error.issues,
        );
      }
      const first = collection.data.value[0];
      if (first === undefined) return undefined;
      return await this.fetchConfiguration(
        parsed.data.domain,
        first.id,
        "read",
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "read");
    }
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = domainFederationConfigurationSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "create", parsed.error.issues);
    }
    try {
      const raw: unknown = await this.client
        .api(
          `/domains/${encodeURIComponent(parsed.data.domain)}/federationConfiguration`,
        )
        .post(buildBody(parsed.data, true));
      // The POST response may not echo every SAML field. Follow up with a
      // GET on the individual configuration so the returned state is
      // symmetric with `read()` and `update()` — convergence relies on that
      // consistency.
      const id = extractCreatedId(raw);
      return await this.fetchConfiguration(parsed.data.domain, id, "create");
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "create");
    }
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    const parsed = domainFederationConfigurationSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "update", parsed.error.issues);
    }
    try {
      await this.client
        .api(
          `/domains/${encodeURIComponent(parsed.data.domain)}/federationConfiguration/${encodeURIComponent(id)}`,
        )
        .patch(buildBody(parsed.data, false));
      return await this.fetchConfiguration(parsed.data.domain, id, "update");
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw toProviderApiError(error, "update");
    }
  }
}

/**
 * Extract the `id` of a newly-created federation configuration from a Graph
 * POST response. The POST may not return every SAML field, so only `id` is
 * read at this layer — the canonical document is fetched via a follow-up
 * `GET` on the individual configuration.
 */
function extractCreatedId(raw: unknown): string {
  const result = z.looseObject({ id: z.string().trim().min(1) }).safeParse(raw);
  if (!result.success) {
    throw new ProviderApiError(PROVIDER_NAME, "create", result.error.issues);
  }
  return result.data.id;
}
