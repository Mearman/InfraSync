/**
 * Thin HTTP client for the GitHub REST API.
 *
 * Uses globalThis.fetch directly — same pattern as the Tailscale provider.
 * Avoids Octokit's per-route generic types which conflict with
 * exactOptionalPropertyTypes in the project's tsconfig.
 *
 * Authentication: Bearer token via the Authorization header.
 * Supports GitHub Enterprise Server via the `baseUrl` config option.
 *
 * @see https://docs.github.com/en/rest
 */

// ─── Client ──────────────────────────────────────────────────────────────────

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly headers: Headers;

  constructor(token: string, baseUrl?: string) {
    this.baseUrl = baseUrl ?? "https://api.github.com";
    this.headers = new Headers({
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  }

  /**
   * Send a GET request to the GitHub REST API.
   *
   * @param path — API path (e.g. "/repos/{owner}/{repo}")
   * @param params — path/query parameters; path params like `{owner}`
   *   are interpolated into the path, remaining params become query string
   */
  async get(path: string, params?: Record<string, unknown>): Promise<unknown> {
    const { url, query } = this.buildUrl(path, params);
    const fullUrl = query !== "" ? `${url}?${query}` : url;
    const response = await globalThis.fetch(fullUrl, {
      method: "GET",
      headers: this.headers,
    });
    if (!response.ok) {
      if (response.status === 404) return undefined;
      throw await this.apiError("GET", path, response);
    }
    return response.json();
  }

  /**
   * Send a POST request to the GitHub REST API.
   *
   * @param path — API path
   * @param params — path parameters interpolated into the path
   * @param body — request body (omitting undefined values)
   */
  async post(
    path: string,
    params: Record<string, unknown> | undefined,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const { url } = this.buildUrl(path, params);
    const opts: RequestInit = {
      method: "POST",
      headers: this.headers,
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(this.stripUndefined(body));
    }
    const response = await globalThis.fetch(url, opts);
    if (!response.ok) {
      throw await this.apiError("POST", path, response);
    }
    return response.json();
  }

  /**
   * Send a PUT request to the GitHub REST API.
   */
  async put(
    path: string,
    params: Record<string, unknown> | undefined,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const { url } = this.buildUrl(path, params);
    const opts: RequestInit = {
      method: "PUT",
      headers: this.headers,
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(this.stripUndefined(body));
    }
    const response = await globalThis.fetch(url, opts);
    if (!response.ok) {
      throw await this.apiError("PUT", path, response);
    }
    return response.json();
  }

  /**
   * Send a PATCH request to the GitHub REST API.
   */
  async patch(
    path: string,
    params: Record<string, unknown> | undefined,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const { url } = this.buildUrl(path, params);
    const opts: RequestInit = {
      method: "PATCH",
      headers: this.headers,
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(this.stripUndefined(body));
    }
    const response = await globalThis.fetch(url, opts);
    if (!response.ok) {
      throw await this.apiError("PATCH", path, response);
    }
    return response.json();
  }

  /**
   * Send a DELETE request to the GitHub REST API.
   * Returns true if successful (204), false if not found (404).
   */
  async delete(
    path: string,
    params?: Record<string, unknown>,
  ): Promise<boolean> {
    const { url } = this.buildUrl(path, params);
    const response = await globalThis.fetch(url, {
      method: "DELETE",
      headers: this.headers,
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw await this.apiError("DELETE", path, response);
    }
    return true;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Interpolate path parameters and build the full URL + query string.
   *
   * Path params like `{owner}` in "/repos/{owner}/{repo}" are interpolated
   * from the params object. Remaining params become the query string.
   */
  private buildUrl(
    path: string,
    params?: Record<string, unknown>,
  ): { url: string; query: string } {
    let resolvedPath = path;
    const pathParamNames = new Set(
      [...path.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .filter((name): name is string => name !== undefined),
    );

    // Interpolate path parameters
    if (params !== undefined) {
      for (const key of pathParamNames) {
        const value = params[key];
        if (value !== undefined) {
          // Path params are always primitives (string/number/boolean).
          // String(value) on an object would give "[object Object]" —
          // that's a caller bug, not something we paper over.
          if (
            typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean"
          ) {
            throw new TypeError(
              `Path parameter "${key}" must be a primitive, got ${typeof value}`,
            );
          }
          resolvedPath = resolvedPath.replace(
            `{${key}}`,
            encodeURIComponent(String(value)),
          );
        }
      }
    }

    // Build query string from non-path parameters
    const queryParams: string[] = [];
    if (params !== undefined) {
      for (const [key, value] of Object.entries(params)) {
        if (pathParamNames.has(key)) continue;
        if (value === undefined) continue;
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          queryParams.push(
            `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
          );
        } else if (Array.isArray(value)) {
          for (const item of value) {
            queryParams.push(
              `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`,
            );
          }
        }
      }
    }

    return {
      url: `${this.baseUrl}${resolvedPath}`,
      query: queryParams.join("&"),
    };
  }

  /**
   * Remove undefined values from an object for JSON serialisation.
   * Avoids sending `"key": null` for fields that should be absent.
   */
  private stripUndefined(
    obj: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Build a descriptive error from a failed API response.
   */
  private async apiError(
    method: string,
    path: string,
    response: Response,
  ): Promise<Error> {
    const body = await response.text().catch(() => "");
    return new Error(
      `GitHub API error: ${method} ${path} returned ${String(response.status)}: ${body}`,
    );
  }
}

/**
 * Narrowing helper — returns the client or throws if not connected.
 */
export function requireClient(client: GitHubClient | undefined): GitHubClient {
  if (client === undefined) {
    throw new Error("GitHub provider not connected — call connect() first");
  }
  return client;
}
