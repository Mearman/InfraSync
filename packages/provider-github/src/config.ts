/**
 * GitHub provider configuration schema.
 *
 * Supports two authentication methods:
 * - Personal access token (classic or fine-grained)
 * - GitHub App installation (appId + privateKey + installationId)
 *
 * Both methods require a `token` field. For GitHub Apps, the token
 * is an installation access token; for PATs, it's the token itself.
 */

import * as z from "zod";

export const githubConfigSchema = z.strictObject({
  /** GitHub personal access token or installation access token */
  token: z.string().trim().min(1),
  /** Optional base URL for GitHub Enterprise Server (default: https://api.github.com) */
  baseUrl: z.string().trim().min(1).optional(),
});

export type GitHubConfig = z.infer<typeof githubConfigSchema>;
