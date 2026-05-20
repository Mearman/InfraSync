/**
 * Dependency cascade resolution.
 *
 * After analyzing commits per package, resolves which packages
 * also need version bumps because their local dependencies changed.
 */

import type { DiscoveredPackage } from "./discover.js";
import type { SemVer } from "./types.js";

const RELEASE_WEIGHT: Record<SemVer, number> = {
  patch: 1,
  minor: 2,
  major: 3,
};

/**
 * Get the higher of two release types.
 */
function higherType(
  a: SemVer | undefined,
  b: SemVer | undefined,
): SemVer | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return RELEASE_WEIGHT[a] >= RELEASE_WEIGHT[b] ? a : b;
}

/**
 * Resolve dependency cascade across all packages.
 *
 * Iterates until stable: if any local dep of a package changed,
 * that package gets at least a patch bump. Transitive deps bubble up.
 *
 * @param packages All discovered packages (mutated in place)
 * @param depsRelease What type of bump a dep change triggers (default: patch)
 */
export function resolveDependencyCascade(
  packages: DiscoveredPackage[],
  depsRelease: SemVer = "patch",
): void {
  let stable = false;

  while (!stable) {
    stable = true;

    for (const pkg of packages) {
      // Skip packages that already have a raw commit-based bump
      if (pkg.rawNextType !== undefined) continue;

      // Check if any local dep has a pending bump
      const changedDeps = pkg.localDeps.filter(
        (dep) => dep.nextType !== undefined,
      );

      if (changedDeps.length > 0) {
        const newType = higherType(pkg.nextType, depsRelease);

        if (newType !== pkg.nextType) {
          pkg.nextType = newType;
          pkg.depsChanged = changedDeps;
          stable = false;
        }
      }
    }
  }
}
