/**
 * Monorepo semantic-release plugin.
 *
 * Provides independent per-package versioning for pnpm monorepos.
 * Used in release.config.ts as a semantic-release plugin.
 *
 * @example
 * ```typescript
 * import { monorepoRelease } from "./src/release/index.js";
 *
 * export default {
 *   branches: ["main"],
 *   plugins: [monorepoRelease],
 * };
 * ```
 */

export { monorepoRelease } from "./plugin.js";
export type {
  SemVer,
  WorkspacePackage,
  ReleaseConfig,
  ReleaseResult,
  SemanticReleaseContext,
} from "./types.js";
