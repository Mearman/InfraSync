/**
 * Discover workspace packages from pnpm-workspace.yaml.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as z from "zod";
import type { PackageManifest } from "./types.js";

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const StringRecordSchema = z.record(z.string(), z.string().trim());

const PublishConfigSchema = z.object({
  registry: z.string().trim().optional(),
  access: z.string().trim().optional(),
});

const PackageJsonSchema = z.object({
  name: z.string().trim(),
  version: z.string().trim().default("0.0.0"),
  private: z.boolean().optional(),
  dependencies: StringRecordSchema.optional(),
  devDependencies: StringRecordSchema.optional(),
  peerDependencies: StringRecordSchema.optional(),
  optionalDependencies: StringRecordSchema.optional(),
  publishConfig: PublishConfigSchema.optional(),
});

// ─── Workspace pattern parsing ───────────────────────────────────────────────

function readPnpmWorkspacePatterns(root: string): string[] {
  const yamlPath = resolve(root, "pnpm-workspace.yaml");
  if (!existsSync(yamlPath)) return [];

  const contents = readFileSync(yamlPath, "utf8");
  const lines = contents.split("\n");
  const patterns: string[] = [];
  let inPackages = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "packages:") {
      inPackages = true;
      continue;
    }
    if (inPackages && trimmed.startsWith("- ")) {
      const pattern = trimmed.slice(2).replace(/['"]/g, "");
      if (!pattern.startsWith("!")) {
        patterns.push(pattern);
      }
    } else if (inPackages && trimmed.length > 0 && !trimmed.startsWith("#")) {
      inPackages = false;
    }
  }

  return patterns;
}

// ─── Pattern expansion ───────────────────────────────────────────────────────

function expandPattern(root: string, pattern: string): string[] {
  const parts = pattern.split("/");
  const base = parts[0];
  const wildcard = parts[1];
  if (base === undefined) return [];

  if (wildcard === "*") {
    return expandSingleLevel(root, base);
  }

  if (wildcard === "**") {
    return expandRecursive(root, base);
  }

  // Specific path
  const pkgJsonPath = resolve(root, base, "package.json");
  return existsSync(pkgJsonPath) ? [pkgJsonPath] : [];
}

function expandSingleLevel(root: string, dir: string): string[] {
  const fullDir = resolve(root, dir);
  if (!existsSync(fullDir)) return [];
  return readdirSync(fullDir)
    .sort()
    .map((entry) => resolve(fullDir, entry, "package.json"))
    .filter((p) => existsSync(p));
}

function expandRecursive(root: string, dir: string): string[] {
  const fullDir = resolve(root, dir);
  if (!existsSync(fullDir)) return [];
  return readdirSync(fullDir)
    .sort()
    .filter((e) => statSync(resolve(fullDir, e)).isDirectory())
    .map((e) => resolve(fullDir, e, "package.json"))
    .filter((p) => existsSync(p));
}

// ─── Manifest parsing ────────────────────────────────────────────────────────

function parsePackageManifest(pkgJsonPath: string): {
  manifest: PackageManifest;
  depNames: string[];
} {
  const raw = readFileSync(pkgJsonPath, "utf8");
  const parsed = PackageJsonSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid package.json: ${pkgJsonPath}`);
  }

  const data = parsed.data;
  const manifest: PackageManifest = {
    name: data.name,
    version: data.version,
    ...(data.private === true ? { private: true as const } : {}),
    dependencies: data.dependencies,
    devDependencies: data.devDependencies,
    peerDependencies: data.peerDependencies,
    optionalDependencies: data.optionalDependencies,
    publishConfig: data.publishConfig,
    __contents__: raw,
  };

  const depNames = new Set<string>();
  for (const scope of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ]) {
    if (scope !== undefined) {
      for (const depName of Object.keys(scope)) {
        depNames.add(depName);
      }
    }
  }

  return { manifest, depNames: [...depNames] };
}

// ─── Discovered package type ────────────────────────────────────────────────

export interface DiscoveredPackage {
  readonly name: string;
  readonly path: string;
  readonly dir: string;
  manifest: PackageManifest;
  localDeps: DiscoveredPackage[];
  readonly depNames: string[];
  lastRelease: { version: string; gitTag: string; gitHead: string } | undefined;
  nextType: "major" | "minor" | "patch" | undefined;
  rawNextType: "major" | "minor" | "patch" | undefined;
  nextVersion: string | undefined;
  commits: {
    hash: string;
    message: string;
    committerDate: Date;
    gitTags: string;
  }[];
  notes: string | undefined;
  depsChanged: DiscoveredPackage[];
}

// ─── Discovery ──────────────────────────────────────────────────────────────

export function discoverPackages(root: string): DiscoveredPackage[] {
  const patterns = readPnpmWorkspacePatterns(root);
  const pkgJsonPaths = new Set<string>();

  for (const pattern of patterns) {
    for (const p of expandPattern(root, pattern)) {
      pkgJsonPaths.add(p);
    }
  }

  const packages: DiscoveredPackage[] = [];
  const nameToPkg = new Map<string, DiscoveredPackage>();

  for (const pkgJsonPath of pkgJsonPaths) {
    const { manifest, depNames } = parsePackageManifest(pkgJsonPath);
    if (manifest.name.length === 0 || manifest.private === true) continue;

    const pkg: DiscoveredPackage = {
      name: manifest.name,
      path: pkgJsonPath,
      dir: resolve(pkgJsonPath, ".."),
      manifest,
      localDeps: [],
      depNames,
      lastRelease: undefined,
      nextType: undefined,
      rawNextType: undefined,
      nextVersion: undefined,
      commits: [],
      notes: undefined,
      depsChanged: [],
    };

    packages.push(pkg);
    nameToPkg.set(manifest.name, pkg);
  }

  // Resolve local deps
  for (const pkg of packages) {
    pkg.localDeps = pkg.depNames
      .map((name) => nameToPkg.get(name))
      .filter((p): p is DiscoveredPackage => p !== undefined);
  }

  return packages;
}
