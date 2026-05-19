import type { Client } from "@microsoft/microsoft-graph-client";
import type { ResourcePort } from "@infrasync/core/provider";
import { RefToken } from "@infrasync/core/refs";
import type { RefBuilder } from "@infrasync/core/handles";
import { ProviderApiError } from "@infrasync/core/errors";
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
  domain: z.string().trim().min(1),
  issuerUri: z.url(),
  displayName: z.string().trim().min(1),
  activeSignInUri: z.url(),
  passiveSignInUri: z.url(),
  metadataExchangeUri: z.url().optional(),
  signOutUri: z.url(),
  signingCertificate: z.string().trim().min(1),
  preferredAuthenticationProtocol: z.enum(["saml", "wsFed"]).default("saml"),
});

export type DomainFederationConfigurationSpec = z.infer<
  typeof domainFederationConfigurationSpecSchema
>;

// ─── State schema ────────────────────────────────────────────────────────────

const domainFederationConfigurationStateSchema = z
  .looseObject({
    id: z.string().trim().min(1),
    domain: z.string().trim().min(1),
    issuerUri: z.string().trim().optional(),
    displayName: z.string().trim().optional(),
    activeSignInUri: z.string().trim().optional(),
    passiveSignInUri: z.string().trim().optional(),
    metadataExchangeUri: z.string().trim().optional(),
    signOutUri: z.string().trim().optional(),
    signingCertificate: z.string().trim().optional(),
    preferredAuthenticationProtocol: z.string().trim().optional(),
  })
  .brand<"EntraIdDomainFederationConfigurationState">()
  .readonly();

// ─── Identity and desired-state sub-schemas ──────────────────────────────────

const identitySchema = domainFederationConfigurationSpecSchema.pick({
  kind: true,
  domain: true,
});

const desiredStateSchema = domainFederationConfigurationSpecSchema.pick({
  kind: true,
  domain: true,
  issuerUri: true,
  displayName: true,
  activeSignInUri: true,
  passiveSignInUri: true,
  metadataExchangeUri: true,
  signOutUri: true,
  signingCertificate: true,
  preferredAuthenticationProtocol: true,
});

// ─── API response validation ─────────────────────────────────────────────────

const singleResponseSchema = z.looseObject({
  id: z.string().trim().min(1),
});

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
  return { ...raw, domain };
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

  async read(spec: unknown): Promise<unknown> {
    const parsed = domainFederationConfigurationSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError(PROVIDER_NAME, "read", parsed.error.issues);
    }
    try {
      const raw: unknown = await this.client
        .api(
          `/domains/${encodeURIComponent(parsed.data.domain)}/federationConfiguration`,
        )
        .get();
      const collection = collectionResponseSchema.safeParse(raw);
      if (!collection.success) {
        throw new ProviderApiError(
          PROVIDER_NAME,
          "read",
          collection.error.issues,
        );
      }
      const first = collection.data.value[0];
      if (first === undefined) return undefined;
      return attachDomain(first, parsed.data.domain);
    } catch (error) {
      if (isNotFound(error)) return undefined;
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
      const validated = validateSingle(raw, "create");
      return attachDomain(validated, parsed.data.domain);
    } catch (error) {
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
      const raw: unknown = await this.client
        .api(
          `/domains/${encodeURIComponent(parsed.data.domain)}/federationConfiguration/${encodeURIComponent(id)}`,
        )
        .get();
      const validated = validateSingle(raw, "update");
      return attachDomain(validated, parsed.data.domain);
    } catch (error) {
      throw toProviderApiError(error, "update");
    }
  }
}
