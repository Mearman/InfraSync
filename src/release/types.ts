/**
 * Monorepo semantic-release plugin for independent per-package versioning.
 *
 * Coordinates releases across all workspace packages:
 * - Discovers packages from pnpm-workspace.yaml
 * - Filters commits per package directory
 * - Determines next version per package via conventional commit analysis
 * - Cascades dependency bumps through the dependency graph
 * - Publishes each package independently to npm
 * - Creates per-package GitHub releases
 * - Writes per-package CHANGELOG.md files
 * - Rewrites workspace:* references to real versions before publishing
 * - Bumps root package.json to aggregate semver
 */

export type SemVer = "major" | "minor" | "patch";

export interface WorkspacePackage {
  /** Package name (e.g. @infrasync-org/core) */
  readonly name: string;
  /** Absolute path to package.json */
  readonly path: string;
  /** Absolute path to package directory */
  readonly dir: string;
  /** Parsed package.json contents */
  manifest: PackageManifest;
  /** Local workspace dependencies */
  localDeps: readonly WorkspacePackage[];
  /** All dependency names (for local resolution) */
  readonly depNames: readonly string[];
  /** Last release from git tags (filled during analyzeCommits) */
  lastRelease: LastRelease | undefined;
  /** Next release type determined by commit analysis */
  nextType: SemVer | undefined;
  /** Raw next type from commit analysis (before dep cascade) */
  rawNextType: SemVer | undefined;
  /** Next version string (filled after version resolution) */
  nextVersion: string | undefined;
  /** Commits affecting this package (filled during analyzeCommits) */
  commits: readonly Commit[];
  /** Generated notes for this package */
  notes: string | undefined;
  /** Local deps that changed and triggered a cascade bump */
  depsChanged: readonly WorkspacePackage[];
}

export interface PackageManifest {
  readonly name: string;
  version: string;
  readonly private?: true;
  readonly dependencies?: Record<string, string> | undefined;
  readonly devDependencies?: Record<string, string> | undefined;
  readonly peerDependencies?: Record<string, string> | undefined;
  readonly optionalDependencies?: Record<string, string> | undefined;
  readonly publishConfig?:
    | {
        readonly registry?: string | undefined;
        readonly access?: string | undefined;
      }
    | undefined;
  /** Stores raw JSON string for format detection during rewrite */
  __contents__?: string;
}

export interface LastRelease {
  readonly version: string;
  readonly gitTag: string;
  readonly gitHead: string;
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly committerDate: Date;
  readonly gitTags: string;
}

export interface ResolvedRelease {
  readonly pkg: WorkspacePackage;
  readonly lastRelease: LastRelease | undefined;
  readonly nextRelease: {
    readonly version: string;
    readonly gitTag: string;
    readonly gitHead: string;
    readonly notes: string;
    readonly type: SemVer;
  };
}

export interface ReleaseConfig {
  /** Commit types and their release rules */
  readonly releaseRules: readonly ReleaseRule[];
  /** Commit types and their changelog section names */
  readonly sectionTypes: readonly SectionType[];
  /** Dependency cascade release type (default: patch) */
  readonly depsRelease?: SemVer;
}

export interface ReleaseRule {
  readonly type: string;
  readonly release: SemVer;
}

export interface SectionType {
  readonly type: string;
  readonly section: string;
}

/** Plugin shape consumed by release.config.ts */
export interface MonorepoReleasePlugin {
  verifyConditions: (
    pluginOptions: unknown,
    context: SemanticReleaseContext,
  ) => Promise<void>;
  analyzeCommits: (
    pluginOptions: unknown,
    context: SemanticReleaseContext,
  ) => Promise<SemVer | undefined>;
  verifyRelease: (
    pluginOptions: unknown,
    context: SemanticReleaseContext,
  ) => Promise<void>;
  generateNotes: (
    pluginOptions: unknown,
    context: SemanticReleaseContext,
  ) => Promise<string>;
  prepare: (
    pluginOptions: unknown,
    context: SemanticReleaseContext,
  ) => Promise<void>;
  publish: (
    pluginOptions: unknown,
    context: SemanticReleaseContext,
  ) => Promise<readonly ReleaseResult[]>;
  success: (
    pluginOptions: unknown,
    context: SemanticReleaseContext,
  ) => Promise<void>;
  fail: (
    pluginOptions: unknown,
    context: SemanticReleaseContext,
  ) => Promise<void>;
}

export interface SemanticReleaseContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly logger: {
    log: (...args: readonly unknown[]) => void;
    error: (...args: readonly unknown[]) => void;
    warn: (...args: readonly unknown[]) => void;
    success: (...args: readonly unknown[]) => void;
  };
  readonly commits: readonly Commit[];
  readonly lastRelease: LastRelease | undefined;
  readonly nextRelease:
    | {
        readonly version: string;
        readonly gitTag: string;
        readonly type: SemVer;
      }
    | undefined;
  readonly options: Record<string, unknown>;
  readonly branch: {
    readonly name: string;
    readonly prerelease?: string;
  };
}

export interface ReleaseResult {
  readonly name: string;
  readonly url: string;
}
