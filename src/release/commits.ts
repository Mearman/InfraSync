/**
 * Filter commits to those affecting a specific package directory.
 * Uses git log with pathspec filtering.
 */

import { execSync } from "node:child_process";
import { relative } from "node:path";
import type { Commit } from "./types.js";

/**
 * Get commits filtered to a package directory since a given ref.
 */
export function filterCommits(
  cwd: string,
  packageDir: string,
  lastGitHead: string | undefined,
): Commit[] {
  const relPath = relative(cwd, packageDir);
  if (relPath.length === 0) return [];

  const range = lastGitHead !== undefined ? `${lastGitHead}..HEAD` : "HEAD";
  const format = "%H%n%B%n%d%n%cI";

  let output: string;
  try {
    output = execSync(`git log --format="${format}" ${range} -- "${relPath}"`, {
      cwd,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  if (output.trim().length === 0) return [];

  // Parse the output — each commit is separated by the format fields
  const commits: Commit[] = [];
  const entries = output.split(/\n(?=[0-9a-f]{40}\n)/);

  for (const entry of entries) {
    const lines = entry.split("\n");
    const hash = lines[0]?.trim();
    if (hash === undefined || hash.length === 0) continue;

    const message = lines.slice(1, -2).join("\n").trim();
    const gitTags = (lines.at(-2) ?? "").trim();
    const dateStr = lines.at(-1)?.trim();

    commits.push({
      hash,
      message,
      committerDate: dateStr !== undefined ? new Date(dateStr) : new Date(),
      gitTags,
    });
  }

  return commits;
}

/**
 * Get the HEAD commit SHA.
 */
export function getHeadSha(cwd: string): string {
  return execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();
}

/**
 * Get the commit SHA for a tag.
 */
export function getTagSha(cwd: string, tag: string): string | undefined {
  try {
    return execSync(`git rev-list -1 ${tag}`, {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Get the last release tag for a package.
 */
export function getLastReleaseTag(
  cwd: string,
  packageName: string,
): { version: string; gitTag: string; gitHead: string } | undefined {
  // Tags are formatted as packageName@version
  const prefix = `${packageName}@`;

  let tags: string;
  try {
    tags = execSync(`git tag --list '${prefix}*' --sort=-version:refname`, {
      cwd,
      encoding: "utf8",
    });
  } catch {
    return undefined;
  }

  const tagLines = tags.trim().split("\n");
  const latestTag = tagLines[0]?.trim();
  if (latestTag === undefined || latestTag.length === 0) return undefined;

  const version = latestTag.slice(prefix.length);
  if (version.length === 0) return undefined;

  const gitHead = getTagSha(cwd, latestTag);
  if (gitHead === undefined) return undefined;

  return { version, gitTag: latestTag, gitHead };
}
