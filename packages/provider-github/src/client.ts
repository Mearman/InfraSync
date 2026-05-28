/**
 * Thin typed wrapper around the Octokit SDK for InfraSync.
 *
 * Provides typed methods for the GitHub REST API endpoints used by
 * InfraSync resources. All methods return `Promise<unknown>` — callers
 * validate with Zod schemas at their boundaries.
 *
 * Authentication: Personal access token or GitHub App installation token
 * via the Octokit constructor. Supports GitHub Enterprise Server via
 * the `baseUrl` config option.
 *
 * @see https://docs.github.com/en/rest
 * @see https://github.com/octokit/octokit.js
 */

import { Octokit } from "octokit";

// ─── Client ──────────────────────────────────────────────────────────────────

export class GitHubClient {
  readonly octokit: Octokit;

  constructor(token: string, baseUrl?: string) {
    this.octokit = new Octokit({
      auth: token,
      ...(baseUrl !== undefined
        ? { baseUrl }
        : {}),
    });
  }
}

/**
 * Narrowing helper — returns the client or throws if not connected.
 */
export function requireClient(
  client: GitHubClient | undefined,
): GitHubClient {
  if (client === undefined) {
    throw new Error(
      "GitHub provider not connected — call connect() first",
    );
  }
  return client;
}
