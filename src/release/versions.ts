/**
 * Version resolution and manifest rewriting.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { DiscoveredPackage } from "./discover.js";
import type { SemVer } from "./types.js";

/**
 * Calculate the next version from a release type.
 */
export function getNextVersion(
  lastVersion: string | undefined,
  releaseType: SemVer,
): string {
  if (lastVersion === undefined) return "1.0.0";

  const parts = lastVersion.split(".").map(Number);
  const major = parts[0];
  const minor = parts[1];
  const patch = parts[2];

  if (major === undefined || minor === undefined || patch === undefined) {
    return "1.0.0";
  }

  switch (releaseType) {
    case "major":
      return `${String(major + 1)}.0.0`;
    case "minor":
      return `${String(major)}.${String(minor + 1)}.0`;
    case "patch":
      return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
  }
}

/**
 * Resolve the aggregate release type for the root package.json.
 * Returns the highest release type across all packages that are releasing.
 */
export function aggregateReleaseType(
  packages: DiscoveredPackage[],
): SemVer | undefined {
  const weights: Record<SemVer, number> = {
    patch: 1,
    minor: 2,
    major: 3,
  };

  let best: SemVer | undefined;
  let bestWeight = 0;

  for (const pkg of packages) {
    if (pkg.nextType !== undefined) {
      const w = weights[pkg.nextType];
      if (w > bestWeight) {
        best = pkg.nextType;
        bestWeight = w;
      }
    }
  }

  return best;
}

/**
 * Rewrite workspace:* references to real versions in a package's manifest.
 * Returns true if any dependency was changed.
 */
export function rewriteManifestDeps(pkg: DiscoveredPackage): boolean {
  const scopeKeys = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;

  let changed = false;
  const manifest = pkg.manifest;

  for (const scopeKey of scopeKeys) {
    const scope = manifest[scopeKey];
    if (scope === undefined) continue;

    for (const dep of pkg.depsChanged) {
      if (dep.nextVersion === undefined) continue;
      const current = scope[dep.name];
      if (current === undefined) continue;
      if (!current.startsWith("workspace:")) continue;

      const resolved = resolveWorkspaceVersion(current, dep.nextVersion);
      if (resolved !== current) {
        scope[dep.name] = resolved;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Write a package.json back to disk.
 * Preserves original formatting (2-space indent, trailing newline).
 */
export function writeManifest(pkg: DiscoveredPackage): void {
  const raw = readFileSync(pkg.path, "utf8");
  const indent = raw.includes("\t") ? "\t" : "  ";
  const trailing = raw.endsWith("\n") ? "\n" : "";

  writeFileSync(
    pkg.path,
    JSON.stringify(pkg.manifest, null, indent) + trailing,
  );
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function resolveWorkspaceVersion(
  currentVersion: string,
  nextVersion: string,
): string {
  if (currentVersion === "workspace:*") {
    return nextVersion;
  }
  if (currentVersion === "workspace:^") {
    return `^${nextVersion}`;
  }
  if (currentVersion === "workspace:~") {
    return `~${nextVersion}`;
  }
  // workspace:^1.0.0 — strip workspace: prefix, apply caret/tilde if present
  const match = /^workspace:([~^]?)(.*)$/.exec(currentVersion);
  if (match !== null) {
    const prefix = match[1];
    return prefix !== undefined && prefix.length > 0
      ? `${prefix}${nextVersion}`
      : nextVersion;
  }
  return currentVersion;
}
