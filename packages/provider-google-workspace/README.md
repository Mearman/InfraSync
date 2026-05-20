# @infrasync-org/google-workspace

InfraSync provider for Google Workspace, backed by the Cloud Identity and Admin SDK REST APIs.

## Auth

Two authentication flows are supported via a discriminated union on the provider config:

- **`oauth-user`** — a one-off OAuth dance against the Cloud Identity scope produces a refresh token bound to a super-admin's Google account. Suitable for interactive setup and small-team automation.
- **`service-account`** — a Google Cloud service account with domain-wide delegation impersonating a super-admin. Suitable for CI and unattended automation.

Both flows additionally require the Workspace `customerId` (looks like `C00xxxxxx`, found in Admin → Account → Account settings → Profile).

## Resources

### `InboundSamlSsoProfile`

Wraps `cloudidentity.googleapis.com/v1/inboundSamlSsoProfiles`. Configures Google Workspace as a SAML **service provider** receiving SSO assertions from an external IdP — e.g. authenticating Google users via Okta, AD FS, or any third-party IdP.

This is **not** the resource for "Google as IdP for Microsoft 365" or any other Google-Workspace-as-IdP federation. See the gap section below.

## The Google-as-IdP gap

Google Workspace can be configured as a SAML identity provider for third-party service providers (Microsoft 365, Salesforce, etc.) via:

**Admin Console → Apps → Web and mobile apps → Add app → SAML app (custom or template)**

At time of writing, Google has not exposed a stable programmable API for managing these SAML apps from the IdP side. The configuration lives entirely in the Admin Console UI. This is a long-standing structural gap in Google's public API surface, not a temporary omission.

The practical consequence: federating Google Workspace into Microsoft 365 (or any other third-party SP) requires a manual Admin Console step to:

1. Create the SAML app (typically from the Microsoft 365 template).
2. Configure the SP entity ID and ACS URL.
3. Download the IdP metadata XML — specifically the **entity ID**, **single sign-on service URL**, and **X.509 signing certificate**.

The downloaded values are then fed into the SP-side federation configuration. For Microsoft 365 specifically, the SP side is `@infrasync-org/microsoft-entra-id`'s `DomainFederationConfiguration` resource, which **is** programmable via Microsoft Graph.

This hybrid (manual Google + automated Entra) is currently the accepted shape of the workflow. Annual SAML certificate rotation is the main operational consequence — set a calendar reminder ~11 months out so the cert is rotated before Google's expires.

## What this package is useful for

- Authenticating against Cloud Identity / Admin SDK REST endpoints (the auth scaffolding is reusable).
- `InboundSamlSsoProfile` for the genuine third-party-IdP-to-Google direction.
- Future resources for the programmable parts of Google Workspace — `User`, `Group`, `OrgUnit`, and similar Admin SDK Directory API surfaces.

The package is intentionally minimal today; it expects to grow in the directions Google's API surface supports.
