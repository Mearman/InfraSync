/**
 * semantic-release configuration for the InfraSync monorepo.
 *
 * Analyses conventional commits to determine the next version, generates
 * changelogs, and creates GitHub releases. Packages share a single version
 * at this stage of the project — per-package independent releases can be
 * introduced with multi-semantic-release once publishing begins.
 *
 * @see https://semantic-release.gitbook.io/semantic-release/
 */

export default {
  branches: ["main"],

  plugins: [
    // ─── Commit analysis ──────────────────────────────────────────────────

    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "perf", release: "patch" },
          { type: "refactor", release: "patch" },
          { type: "docs", release: "patch" },
          { breaking: true, release: "major" },
        ],
        parserOpts: {
          noteKeywords: ["BREAKING CHANGE", "BREAKING CHANGES"],
        },
      },
    ],

    // ─── Changelog generation ─────────────────────────────────────────────

    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        parserOpts: {
          noteKeywords: ["BREAKING CHANGE", "BREAKING CHANGES"],
        },
        writerOpts: {
          groupBy: "type",
          commitGroupsSort: "title",
          commitsSort: ["scope", "subject"],
        },
      },
    ],

    // ─── Changelog file ───────────────────────────────────────────────────

    [
      "@semantic-release/changelog",
      {
        changelogFile: "CHANGELOG.md",
        changelogTitle:
          "# Changelog\n\nAll notable changes to the InfraSync project are documented here.",
      },
    ],

    // ─── Version bumping ──────────────────────────────────────────────────
    //
    // @semantic-release/npm bumps the version in the root package.json.
    // The exec plugin then propagates the version to all workspace packages.

    [
      "@semantic-release/npm",
      {
        npmPublish: false,
        tarballDir: "dist",
      },
    ],

    [
      "@semantic-release/exec",
      {
        // Propagate the released version to every workspace package
        prepareCmd:
          "pnpm -r exec -- node -e \"const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='${nextRelease.version}';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\\n')\"",
      },
    ],

    // ─── Git commit & tag ─────────────────────────────────────────────────

    [
      "@semantic-release/git",
      {
        assets: [
          "CHANGELOG.md",
          "package.json",
          "pnpm-lock.yaml",
          "packages/*/package.json",
        ],
        message: "chore(release): ${nextRelease.version} [skip ci]",
      },
    ],

    // ─── GitHub release ───────────────────────────────────────────────────

    [
      "@semantic-release/github",
      {
        assets: [{ path: "dist/*.tgz", label: "Distribution tarball" }],
        successComment: false,
        failComment: false,
      },
    ],
  ],
};
