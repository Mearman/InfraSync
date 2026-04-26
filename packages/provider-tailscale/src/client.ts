/**
 * Thin typed client for the Tailscale API v2.
 *
 * Covers the endpoints used by the InfraSync adapter:
 * - ACL policy (GET/POST)
 * - Auth keys (CRUD)
 * - DNS nameservers (GET/POST)
 * - DNS search paths (GET/POST)
 * - DNS preferences (GET/POST)
 *
 * All methods return `Promise<unknown>` — callers validate with Zod schemas
 * at their boundaries.
 *
 * Authentication: Bearer token via the Authorization header.
 * Base URL: https://api.tailscale.com/api/v2
 *
 * @see https://tailscale.com/kb/1101/api
 */

// ─── Request types ───────────────────────────────────────────────────────────

export interface CreateKeyRequest {
  readonly description?: string;
  readonly reusable?: boolean;
  readonly ephemeral?: boolean;
  readonly preapproved?: boolean;
  readonly tags?: readonly string[];
  readonly expirySeconds?: number;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class TailscaleClient {
  private readonly baseUrl: string;
  private readonly headers: Headers;

  constructor(apiKey: string, baseUrl?: string) {
    this.baseUrl = baseUrl ?? "https://api.tailscale.com/api/v2";
    this.headers = new Headers({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    });
  }

  // ─── ACL Policy ──────────────────────────────────────────────────────────

  getAcl(tailnet: string): Promise<unknown> {
    return this.getJson(`/tailnet/${tailnet}/acl`);
  }

  setAcl(tailnet: string, policy: unknown): Promise<unknown> {
    return this.postJson(`/tailnet/${tailnet}/acl`, policy);
  }

  // ─── Auth Keys ───────────────────────────────────────────────────────────

  listKeys(tailnet: string): Promise<unknown> {
    return this.getJson(`/tailnet/${tailnet}/keys`);
  }

  createKey(tailnet: string, req: CreateKeyRequest): Promise<unknown> {
    return this.postJson(`/tailnet/${tailnet}/keys`, {
      capabilities: {
        devices: {
          create: {
            reusable: req.reusable ?? false,
            ephemeral: req.ephemeral ?? false,
            preapproved: req.preapproved ?? false,
            tags: req.tags ?? [],
          },
        },
      },
      description: req.description ?? "",
      expirySeconds: req.expirySeconds,
    });
  }

  getKey(tailnet: string, keyId: string): Promise<unknown> {
    return this.getJson(`/tailnet/${tailnet}/keys/${keyId}`);
  }

  async deleteKey(tailnet: string, keyId: string): Promise<void> {
    const response = await this.fetch(`/tailnet/${tailnet}/keys/${keyId}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(
        `Tailscale API error: DELETE /keys/${keyId} returned ${String(response.status)}`,
      );
    }
  }

  // ─── DNS Nameservers ────────────────────────────────────────────────────

  getDnsNameservers(tailnet: string): Promise<unknown> {
    return this.getJson(`/tailnet/${tailnet}/dns/nameservers`);
  }

  setDnsNameservers(
    tailnet: string,
    nameservers: readonly string[],
  ): Promise<unknown> {
    return this.postJson(`/tailnet/${tailnet}/dns/nameservers`, {
      nameservers,
    });
  }

  // ─── DNS Search Paths ───────────────────────────────────────────────────

  getDnsSearchPaths(tailnet: string): Promise<unknown> {
    return this.getJson(`/tailnet/${tailnet}/dns/searchpaths`);
  }

  setDnsSearchPaths(
    tailnet: string,
    searchPaths: readonly string[],
  ): Promise<unknown> {
    return this.postJson(`/tailnet/${tailnet}/dns/searchpaths`, {
      searchPaths,
    });
  }

  // ─── DNS Preferences ────────────────────────────────────────────────────

  getDnsPreferences(tailnet: string): Promise<unknown> {
    return this.getJson(`/tailnet/${tailnet}/dns/preferences`);
  }

  setDnsPreferences(
    tailnet: string,
    preferences: { readonly magicDNS: boolean },
  ): Promise<unknown> {
    return this.postJson(`/tailnet/${tailnet}/dns/preferences`, preferences);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const response = await globalThis.fetch(url, {
      ...init,
      headers: this.headers,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Tailscale API error: ${init?.method ?? "GET"} ${path} returned ${String(response.status)}: ${body}`,
      );
    }
    return response;
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.fetch(path);
    return response.json();
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetch(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return response.json();
  }
}
