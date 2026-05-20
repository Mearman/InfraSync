/**
 * Monorepo semantic-release plugin — main entry point.
 *
 * Coordinates independent per-package versioning across the workspace:
 * discovers packages, filters commits, resolves dependency cascades,
 * publishes each to npm, and creates per-package GitHub releases.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import * as z from "zod";
import { discoverPackages, type DiscoveredPackage } from "./discover.js";
import { filterCommits, getLastReleaseTag } from "./commits.js";
import { resolveDependencyCascade } from "./cascade.js";
import {
  getNextVersion,
  aggregateReleaseType,
  rewriteManifestDeps,
  writeManifest,
} from "./versions.js";
import type { SemVer, ReleaseConfig, ReleaseResult } from "./types.js";

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const SemVerSchema = z.enum(["major", "minor", "patch"]);

const ReleaseRuleSchema = z.object({
  type: z.string().trim(),
  release: SemVerSchema,
});

const SectionTypeSchema = z.object({
  type: z.string().trim(),
  section: z.string().trim(),
});

const ReleaseConfigSchema = z.object({
  releaseRules: z.array(ReleaseRuleSchema).optional(),
  sectionTypes: z.array(SectionTypeSchema).optional(),
  depsRelease: SemVerSchema.optional(),
});

const RootPackageSchema = z.object({
  version: z.string().trim(),
});

// ─── Type guards ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Default config ──────────────────────────────────────────────────────────

const DEFAULT_RELEASE_RULES: readonly {
  type: string;
  release: SemVer;
}[] = [
  { type: "feat", release: "minor" },
  { type: "fix", release: "patch" },
  { type: "perf", release: "patch" },
  { type: "refactor", release: "patch" },
  { type: "docs", release: "patch" },
  { type: "style", release: "patch" },
  { type: "test", release: "patch" },
  { type: "build", release: "patch" },
  { type: "ci", release: "patch" },
  { type: "chore", release: "patch" },
  { type: "revert", release: "patch" },
];

const DEFAULT_SECTION_TYPES: readonly {
  type: string;
  section: string;
}[] = [
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "perf", section: "Performance" },
  { type: "refactor", section: "Refactoring" },
  { type: "docs", section: "Documentation" },
  { type: "test", section: "Tests" },
  { type: "build", section: "Build" },
  { type: "ci", section: "CI" },
  { type: "chore", section: "Chores" },
  { type: "revert", section: "Reverts" },
];

// ─── Shared state ────────────────────────────────────────────────────────────

let packages: DiscoveredPackage[] = [];
let releasedPackages: DiscoveredPackage[] = [];
let releaseConfig: ReleaseConfig;

// ─── Commit analysis ─────────────────────────────────────────────────────────

const RELEASE_WEIGHTS: Record<SemVer, number> = {
  patch: 1,
  minor: 2,
  major: 3,
};

function higherType(
  a: SemVer | undefined,
  b: SemVer | undefined,
): SemVer | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return RELEASE_WEIGHTS[a] >= RELEASE_WEIGHTS[b] ? a : b;
}

/**
 * Determine release type from conventional commit messages.
 */
function analyzeCommitMessages(
  commits: readonly { message: string }[],
  rules: readonly { type: string; release: SemVer }[],
): SemVer | undefined {
  let result: SemVer | undefined;

  for (const commit of commits) {
    const firstLine = commit.message.split("\n")[0];
    if (firstLine === undefined) continue;

    // Check for BREAKING CHANGE in footer
    if (
      commit.message.includes("BREAKING CHANGE:") ||
      commit.message.includes("BREAKING CHANGES:")
    ) {
      result = "major";
      continue;
    }

    // Match conventional commit: type(scope)!: subject
    const match = /^(\w+)(?:\([^)]*\))?(!)?\s*:/.exec(firstLine);
    if (match === null) continue;

    const commitType = match[1];
    const breaking = match[2] === "!";

    if (breaking) {
      result = "major";
      continue;
    }

    if (commitType === undefined) continue;

    const rule = rules.find((r) => r.type === commitType);
    if (rule !== undefined) {
      result = higherType(result, rule.release);
    }
  }

  return result;
}

// ─── Notes generation ────────────────────────────────────────────────────────

function generatePackageNotes(
  pkg: DiscoveredPackage,
  sectionTypes: readonly { type: string; section: string }[],
): string {
  const sections = new Map<string, string[]>();

  for (const commit of pkg.commits) {
    const firstLine = commit.message.split("\n")[0];
    if (firstLine === undefined) continue;

    const match = /^(\w+)(?:\([^)]*\))?\s*:\s*(.*)/.exec(firstLine);
    if (match === null) continue;

    const commitType = match[1];
    const subject = match[2];
    if (commitType === undefined || subject === undefined) continue;

    const section = sectionTypes.find((s) => s.type === commitType);
    if (section === undefined) continue;

    let items = sections.get(section.section);
    if (items === undefined) {
      items = [];
      sections.set(section.section, items);
    }
    items.push(
      `- ${subject.trim()} ([${commit.hash.slice(0, 7)}](https://github.com/ExaDev/InfraSync/commit/${commit.hash})`,
    );
  }

  const parts: string[] = [];

  for (const { section } of sectionTypes) {
    const items = sections.get(section);
    if (items === undefined) continue;
    parts.push(`### ${section}\n`);
    parts.push(items.join("\n"));
    parts.push("");
  }

  // Dependency upgrade section
  if (pkg.depsChanged.length > 0) {
    parts.push("### Dependencies\n");
    for (const dep of pkg.depsChanged) {
      if (dep.nextVersion !== undefined) {
        parts.push(`- **${dep.name}:** upgraded to ${dep.nextVersion}`);
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ─── Changelog ───────────────────────────────────────────────────────────────

function writeChangelog(pkg: DiscoveredPackage): void {
  const changelogPath = resolve(pkg.dir, "CHANGELOG.md");
  const existing = existsSync(changelogPath)
    ? readFileSync(changelogPath, "utf8")
    : "# Changelog\n";

  const headerEnd = existing.indexOf("\n## ");
  const header = headerEnd !== -1 ? existing.slice(0, headerEnd + 1) : existing;

  const date = new Date().toISOString().slice(0, 10);
  const version = pkg.nextVersion ?? "unknown";
  const notes = pkg.notes ?? "";
  const entry = `## ${version} (${date})\n\n${notes}\n`;
  const rest = headerEnd !== -1 ? existing.slice(headerEnd + 1) : "";

  writeFileSync(changelogPath, header + "\n" + entry + rest);
}

// ─── Config parsing ─────────────────────────────────────────────────────────

function parseConfig(pluginOptions: unknown): ReleaseConfig {
  const parsed = ReleaseConfigSchema.safeParse(pluginOptions);
  if (!parsed.success) {
    return {
      releaseRules: DEFAULT_RELEASE_RULES,
      sectionTypes: DEFAULT_SECTION_TYPES,
      depsRelease: "patch",
    };
  }

  const opts = parsed.data;
  return {
    releaseRules: opts.releaseRules ?? DEFAULT_RELEASE_RULES,
    sectionTypes: opts.sectionTypes ?? DEFAULT_SECTION_TYPES,
    depsRelease: opts.depsRelease ?? "patch",
  };
}

// ─── Topological sort ────────────────────────────────────────────────────────

function topologicalSort(pkgs: DiscoveredPackage[]): DiscoveredPackage[] {
  const sorted: DiscoveredPackage[] = [];
  const visited = new Set<string>();

  function visit(pkg: DiscoveredPackage): void {
    if (visited.has(pkg.name)) return;
    visited.add(pkg.name);

    for (const dep of pkg.localDeps) {
      const inScope = pkgs.find((p) => p.name === dep.name);
      if (inScope !== undefined) {
        visit(inScope);
      }
    }

    sorted.push(pkg);
  }

  for (const pkg of pkgs) {
    visit(pkg);
  }

  return sorted;
}

// ─── Plugin lifecycle ────────────────────────────────────────────────────────

export const monorepoRelease = {
  verifyConditions(
    pluginOptions: unknown,
    context: {
      readonly cwd: string;
      readonly logger: {
        log: (...args: readonly unknown[]) => void;
      };
    },
  ): void {
    releaseConfig = parseConfig(pluginOptions);
    packages = discoverPackages(context.cwd);
    context.logger.log(
      `Discovered ${String(packages.length)} workspace packages`,
    );

    for (const pkg of packages) {
      context.logger.log(`  ${pkg.name}`);
    }
  },

  analyzeCommits(
    _pluginOptions: unknown,
    context: {
      readonly cwd: string;
      readonly logger: {
        log: (...args: readonly unknown[]) => void;
        success: (...args: readonly unknown[]) => void;
      };
      readonly branch: { readonly name: string };
    },
  ): SemVer | undefined {
    // Phase 1: Filter commits and analyze per package
    for (const pkg of packages) {
      pkg.lastRelease = getLastReleaseTag(context.cwd, pkg.name);
      pkg.commits = filterCommits(
        context.cwd,
        pkg.dir,
        pkg.lastRelease?.gitHead,
      );

      if (pkg.commits.length > 0) {
        pkg.rawNextType = analyzeCommitMessages(
          pkg.commits,
          releaseConfig.releaseRules,
        );
        pkg.nextType = pkg.rawNextType;
      }
    }

    // Phase 2: Resolve dependency cascade
    resolveDependencyCascade(packages, releaseConfig.depsRelease);

    // Phase 3: Resolve versions
    for (const pkg of packages) {
      if (pkg.nextType !== undefined) {
        pkg.nextVersion = getNextVersion(
          pkg.lastRelease?.version,
          pkg.nextType,
        );
        const lastVersion = pkg.lastRelease?.version ?? "none";
        context.logger.success(
          `${pkg.name}: ${lastVersion} → ${pkg.nextVersion} (${pkg.nextType})`,
        );
      }
    }

    // Return the aggregate release type for the root package
    return aggregateReleaseType(packages);
  },

  verifyRelease(): void {
    // Nothing additional to verify
  },

  generateNotes(): string {
    const releasing = packages.filter((p) => p.nextVersion !== undefined);

    // Generate per-package notes
    for (const pkg of releasing) {
      pkg.notes = generatePackageNotes(pkg, releaseConfig.sectionTypes);
    }

    // Build combined notes for the GitHub release body
    const parts: string[] = [];
    for (const pkg of releasing) {
      const version = pkg.nextVersion ?? "unknown";
      const notes = pkg.notes ?? "";
      parts.push(`## ${pkg.name}@${version}\n\n${notes}`);
    }

    // Summary footer
    const names = releasing.map(
      (p) => `${p.name}@${p.nextVersion ?? "unknown"}`,
    );
    const count = String(releasing.length);
    parts.push(
      `---\n\n**${count} package${releasing.length !== 1 ? "s" : ""} released:** ${names.join(", ")}`,
    );

    return parts.join("\n");
  },

  prepare(_pluginOptions: unknown, context: { readonly cwd: string }): void {
    const rootPkgPath = resolve(context.cwd, "package.json");
    const rawRoot = readFileSync(rootPkgPath, "utf8");
    const rootVersionParsed = RootPackageSchema.safeParse(JSON.parse(rawRoot));
    const rootVersion = rootVersionParsed.success
      ? rootVersionParsed.data.version
      : "0.0.0";

    const aggregateType = aggregateReleaseType(packages);
    const newRootVersion =
      aggregateType !== undefined
        ? getNextVersion(rootVersion, aggregateType)
        : rootVersion;

    // Update releasing packages: bump version, rewrite deps, write changelog
    const releasing = packages.filter((p) => p.nextVersion !== undefined);

    for (const pkg of releasing) {
      if (pkg.nextVersion !== undefined) {
        pkg.manifest.version = pkg.nextVersion;
      }
      rewriteManifestDeps(pkg);
      writeManifest(pkg);
      writeChangelog(pkg);
    }

    // Write root package.json — parsed via Zod so we know the shape
    const indent = rawRoot.includes("\t") ? "\t" : "  ";
    const rootRaw: unknown = JSON.parse(rawRoot);
    if (!isRecord(rootRaw)) {
      throw new Error("Root package.json is not a valid JSON object");
    }
    rootRaw.version = newRootVersion;
    writeFileSync(rootPkgPath, JSON.stringify(rootRaw, null, indent) + "\n");

    // Stage all changes
    execSync(
      "git add packages/*/package.json packages/*/CHANGELOG.md package.json pnpm-lock.yaml",
      { cwd: context.cwd, stdio: "pipe" },
    );
  },

  publish(
    _pluginOptions: unknown,
    context: {
      readonly cwd: string;
      readonly env: Record<string, string | undefined>;
      readonly logger: {
        log: (...args: readonly unknown[]) => void;
        success: (...args: readonly unknown[]) => void;
        error: (...args: readonly unknown[]) => void;
        warn: (...args: readonly unknown[]) => void;
      };
    },
  ): ReleaseResult[] {
    const releasing = packages.filter((p) => p.nextVersion !== undefined);
    releasedPackages = releasing;
    const results: ReleaseResult[] = [];

    // Sort by dependency order
    const sorted = topologicalSort(releasing);

    for (const pkg of sorted) {
      const version = pkg.nextVersion ?? "0.0.0";
      const tag = `${pkg.name}@${version}`;

      // Create git tag
      try {
        execSync(`git tag ${tag}`, {
          cwd: context.cwd,
          stdio: "pipe",
        });
        context.logger.log(`Created tag: ${tag}`);
      } catch {
        context.logger.warn(`Tag ${tag} already exists — skipping`);
      }

      // npm publish
      const npmToken = context.env.NPM_TOKEN;
      if (npmToken === undefined) {
        context.logger.error("NPM_TOKEN not set — skipping npm publish");
        throw new Error("NPM_TOKEN environment variable is required");
      }

      try {
        execSync("pnpm publish --access public --no-git-checks", {
          cwd: pkg.dir,
          stdio: "pipe",
          env: { ...process.env, NODE_AUTH_TOKEN: npmToken },
        });
        context.logger.success(`Published ${pkg.name}@${version} to npm`);
      } catch (error) {
        context.logger.error(`Failed to publish ${pkg.name}: ${String(error)}`);
        throw error;
      }

      results.push({
        name: pkg.name,
        url: `https://www.npmjs.com/package/${pkg.name}/v/${version}`,
      });
    }

    // Push tags
    try {
      execSync("git push --tags", {
        cwd: context.cwd,
        stdio: "pipe",
      });
    } catch {
      context.logger.warn("Failed to push tags");
    }

    return results;
  },

  success(
    _pluginOptions: unknown,
    context: {
      readonly cwd: string;
      readonly logger: {
        success: (...args: readonly unknown[]) => void;
        warn: (...args: readonly unknown[]) => void;
      };
    },
  ): void {
    // Create per-package GitHub releases
    for (const pkg of releasedPackages) {
      const version = pkg.nextVersion;
      if (version === undefined || pkg.notes === undefined) continue;

      const tag = `${pkg.name}@${version}`;
      const body = `## ${tag}\n\n${pkg.notes}`;

      try {
        execSync(
          `gh release create "${tag}" --title "${tag}" --notes ${JSON.stringify(body)} --repo ExaDev/InfraSync`,
          { cwd: context.cwd, stdio: "pipe" },
        );
        context.logger.success(`Created GitHub release: ${tag}`);
      } catch {
        context.logger.warn(`Failed to create GitHub release for ${tag}`);
      }
    }
  },

  fail(
    _pluginOptions: unknown,
    context: {
      readonly logger: {
        error: (...args: readonly unknown[]) => void;
      };
    },
  ): void {
    context.logger.error("Monorepo release failed");
  },
};
