/**
 * Thin typed client for the Namecheap XML API.
 *
 * All requests are HTTP GET with query parameters. All responses are XML.
 * Covers DNS record management (getHosts, setHosts) and domain queries.
 *
 * Auth: ApiUser, ApiKey, UserName, ClientIp query params on every request.
 * Production: https://api.namecheap.com/xml.response
 * Sandbox: https://api.sandbox.namecheap.com/xml.response
 *
 * @see https://www.namecheap.com/support/api/intro/
 */

import {
  parseXml,
  isApiSuccess,
  extractErrors,
  extractChildren,
  getAttr,
} from "./xml-parser.js";
import type { XmlElement } from "./xml-parser.js";

export interface NamecheapRecord {
  readonly hostId: number;
  readonly name: string;
  readonly type: string;
  readonly address: string;
  readonly mxPref: number;
  readonly ttl: number;
}

export interface NamecheapSetRecord {
  readonly hostName: string;
  readonly recordType: string;
  readonly address: string;
  readonly mxPref: number;
  readonly ttl: number;
}

export class NamecheapClient {
  private readonly baseUrl: string;
  private readonly authParams: URLSearchParams;

  constructor(
    apiUser: string,
    apiKey: string,
    userName: string,
    clientIp: string,
    baseUrl?: string,
  ) {
    this.baseUrl = baseUrl ?? "https://api.namecheap.com/xml.response";
    this.authParams = new URLSearchParams({
      ApiUser: apiUser,
      ApiKey: apiKey,
      UserName: userName,
      ClientIp: clientIp,
    });
  }

  // ─── DNS Records ────────────────────────────────────────────────────────

  async getHosts(
    sld: string,
    tld: string,
  ): Promise<readonly NamecheapRecord[]> {
    const xml = await this.call("namecheap.domains.dns.getHosts", {
      SLD: sld,
      TLD: tld,
    });

    const hostElements = extractChildren(
      xml,
      "CommandResponse",
      "DomainDNSGetHostsResult",
      "host",
    );

    return hostElements.map((el: XmlElement) => ({
      hostId: Number(getAttr(el, "HostId", "0")),
      name: getAttr(el, "Name"),
      type: getAttr(el, "Type"),
      address: getAttr(el, "Address"),
      mxPref: Number(getAttr(el, "MXPref", "0")),
      ttl: Number(getAttr(el, "TTL", "300")),
    }));
  }

  async setHosts(
    sld: string,
    tld: string,
    records: readonly NamecheapSetRecord[],
  ): Promise<void> {
    const params: Record<string, string> = {
      SLD: sld,
      TLD: tld,
    };

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      // Indexed access returns T | undefined with noUncheckedIndexedAccess,
      // but we're iterating within bounds so it's safe.
      if (record === undefined) continue;
      const idx = String(i + 1);
      params[`HostName${idx}`] = record.hostName;
      params[`RecordType${idx}`] = record.recordType;
      params[`Address${idx}`] = record.address;
      params[`MXPref${idx}`] = String(record.mxPref);
      params[`TTL${idx}`] = String(record.ttl);
    }

    await this.call("namecheap.domains.dns.setHosts", params);
  }

  // ─── Domains ────────────────────────────────────────────────────────────

  async getDomains(params?: {
    listType?: string;
    page?: number;
    pageSize?: number;
    sortBy?: string;
  }): Promise<unknown> {
    const query: Record<string, string> = {};
    if (params?.listType !== undefined) query.ListType = params.listType;
    if (params?.page !== undefined) query.Page = String(params.page);
    if (params?.pageSize !== undefined)
      query.PageSize = String(params.pageSize);
    if (params?.sortBy !== undefined) query.SortBy = params.sortBy;

    return this.call("namecheap.domains.getList", query);
  }

  async getNameservers(sld: string, tld: string): Promise<readonly string[]> {
    const xml = await this.call("namecheap.domains.dns.getList", {
      SLD: sld,
      TLD: tld,
    });

    const result = extractChildren(
      xml,
      "CommandResponse",
      "DomainDNSGetListResult",
      "Nameserver",
    );

    return result
      .map((el: XmlElement) => getAttr(el, "Name"))
      .filter((ns) => ns.length > 0);
  }

  async setCustomNameservers(
    sld: string,
    tld: string,
    nameservers: readonly string[],
  ): Promise<void> {
    await this.call("namecheap.domains.dns.setCustom", {
      SLD: sld,
      TLD: tld,
      Nameservers: nameservers.join(","),
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private async call(
    command: string,
    params?: Record<string, string>,
  ): Promise<XmlElement> {
    const query = new URLSearchParams(this.authParams);
    query.set("Command", command);
    if (params !== undefined) {
      for (const [key, value] of Object.entries(params)) {
        query.set(key, value);
      }
    }

    const url = `${this.baseUrl}?${query.toString()}`;
    const response = await globalThis.fetch(url);

    if (!response.ok) {
      throw new Error(
        `Namecheap API error: ${String(response.status)} ${response.statusText}`,
      );
    }

    const text = await response.text();
    const xml = parseXml(text);

    if (!isApiSuccess(xml)) {
      const errors = extractErrors(xml);
      throw new Error(
        `Namecheap API error: ${command} returned errors: ${errors.join(", ")}`,
      );
    }

    return xml;
  }
}

/**
 * Narrowing helper — returns the client or throws if not connected.
 */
export function requireClient(
  client: NamecheapClient | undefined,
): NamecheapClient {
  if (client === undefined) {
    throw new Error("Namecheap provider not connected — call connect() first");
  }
  return client;
}

/**
 * Split a full domain name into SLD and TLD components.
 * e.g. "example.co.uk" → { sld: "example", tld: "co.uk" }
 * Handles common multi-part TLDs.
 */
export function splitDomain(domain: string): { sld: string; tld: string } {
  const multiPartTlds = [
    "co.uk",
    "org.uk",
    "me.uk",
    "co.nz",
    "net.nz",
    "org.nz",
    "com.au",
    "net.au",
    "org.au",
    "com.br",
    "net.br",
    "org.br",
    "co.jp",
    "or.jp",
    "ne.jp",
    "co.in",
    "net.in",
    "org.in",
    "com.sg",
    "com.hk",
    "com.tw",
    "com.tr",
    "com.mx",
    "org.mx",
    "com.ar",
    "co.za",
    "org.za",
    "co.ke",
    "co.il",
    "com.my",
    "com.ph",
  ];

  const lower = domain.toLowerCase();
  for (const tld of multiPartTlds) {
    if (lower.endsWith(`.${tld}`)) {
      const sld = lower.slice(0, -(tld.length + 1));
      return { sld, tld };
    }
  }

  // Simple TLD: last part after the final dot
  const lastDot = lower.lastIndexOf(".");
  if (lastDot === -1) {
    return { sld: lower, tld: "" };
  }
  return {
    sld: lower.slice(0, lastDot),
    tld: lower.slice(lastDot + 1),
  };
}
