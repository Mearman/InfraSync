/**
 * Thin typed client for the name.com v4 REST API.
 *
 * Covers DNS records and domain management endpoints.
 * All methods return Promise<unknown> — callers validate with Zod schemas
 * at their boundaries.
 *
 * Authentication: HTTP Basic (username:token).
 * Base URL: https://api.name.com (test: https://api.dev.name.com)
 *
 * @see https://www.name.com/api-docs
 */

export class NamecomClient {
  private readonly baseUrl: string;
  private readonly headers: Headers;

  constructor(username: string, apiToken: string, baseUrl?: string) {
    this.baseUrl = baseUrl ?? "https://api.name.com";
    this.headers = new Headers({
      Authorization: `Basic ${btoa(`${username}:${apiToken}`)}`,
      "Content-Type": "application/json",
    });
  }

  // ─── DNS Records ────────────────────────────────────────────────────────

  listRecords(domainName: string): Promise<unknown> {
    return this.getJson(`/v4/domains/${domainName}/records`);
  }

  getRecord(domainName: string, id: number): Promise<unknown> {
    return this.getJson(`/v4/domains/${domainName}/records/${String(id)}`);
  }

  createRecord(
    domainName: string,
    record: {
      host: string;
      type: string;
      answer: string;
      ttl?: number;
      priority?: number;
    },
  ): Promise<unknown> {
    return this.postJson(`/v4/domains/${domainName}/records`, record);
  }

  updateRecord(
    domainName: string,
    id: number,
    record: {
      host: string;
      type: string;
      answer: string;
      ttl?: number;
      priority?: number;
    },
  ): Promise<unknown> {
    return this.putJson(
      `/v4/domains/${domainName}/records/${String(id)}`,
      record,
    );
  }

  deleteRecord(domainName: string, id: number): Promise<void> {
    return this.delete(`/v4/domains/${domainName}/records/${String(id)}`);
  }

  // ─── Domains ────────────────────────────────────────────────────────────

  listDomains(params?: {
    perPage?: number;
    page?: number;
    domainName?: string;
  }): Promise<unknown> {
    const query = new URLSearchParams();
    if (params?.perPage !== undefined)
      query.set("perPage", String(params.perPage));
    if (params?.page !== undefined) query.set("page", String(params.page));
    if (params?.domainName !== undefined)
      query.set("domainName", params.domainName);
    const qs = query.toString();
    return this.getJson(`/v4/domains${qs.length > 0 ? `?${qs}` : ""}`);
  }

  getDomain(domainName: string): Promise<unknown> {
    return this.getJson(`/v4/domains/${domainName}`);
  }

  setNameservers(domainName: string, nameservers: string[]): Promise<unknown> {
    return this.postJson(`/v4/domains/${domainName}:setNameservers`, {
      nameservers,
    });
  }

  enableAutorenew(domainName: string): Promise<unknown> {
    return this.postJson(
      `/v4/domains/${domainName}:enableAutorenew`,
      undefined,
    );
  }

  disableAutorenew(domainName: string): Promise<unknown> {
    return this.postJson(
      `/v4/domains/${domainName}:disableAutorenew`,
      undefined,
    );
  }

  lockDomain(domainName: string): Promise<unknown> {
    return this.postJson(`/v4/domains/${domainName}:lock`, undefined);
  }

  unlockDomain(domainName: string): Promise<unknown> {
    return this.postJson(`/v4/domains/${domainName}:unlock`, undefined);
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
        `name.com API error: ${init?.method ?? "GET"} ${path} returned ${String(response.status)}: ${body}`,
      );
    }
    return response;
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.fetch(path);
    return response.json();
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const init: RequestInit = { method: "POST" };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await this.fetch(path, init);
    return response.json();
  }

  private async putJson(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetch(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return response.json();
  }

  private async delete(path: string): Promise<void> {
    await this.fetch(path, { method: "DELETE" });
  }
}

/**
 * Narrowing helper — returns the client or throws if not connected.
 */
export function requireClient(
  client: NamecomClient | undefined,
): NamecomClient {
  if (client === undefined) {
    throw new Error("name.com provider not connected — call connect() first");
  }
  return client;
}
