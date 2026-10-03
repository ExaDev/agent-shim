import type { Options } from "semantic-release";

/**
 * Runs on `main`. Decides the next version from Conventional Commits (a `feat` commit bumps minor, `fix`/`perf`/`revert`/`refactor`/`docs`/`build` bump patch, a BREAKING CHANGE footer bumps major), then creates and pushes the tag plus a chore(release) commit bumping CHANGELOG.md and package.json. `@semantic-release/npm` runs with npmPublish: false so it only bumps the version field -- actual npm publishing (OIDC trusted publishing), GitHub Release creation, and the Homebrew/Scoop tap updates are this project's own jobs in .github/workflows/ci.yml, not semantic-release plugins, since they need this project's own multi-platform asset list and release notes body rather than `@semantic-release/github`'s generic ones.
 */
const releaseNoteTypes = [
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "perf", section: "Performance Improvements" },
  { type: "revert", section: "Reverts" },
  { type: "refactor", section: "Code Refactoring" },
  { type: "docs", section: "Documentation" },
  { type: "build", section: "Build System" },
  { type: "ci", section: "Continuous Integration" },
  { type: "test", section: "Tests" },
  { type: "style", section: "Styles" },
];

const config: Options = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { type: "refactor", release: "patch" },
          { type: "docs", release: "patch" },
          { type: "build", release: "patch" },
        ],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      { preset: "conventionalcommits", presetConfig: { types: releaseNoteTypes } },
    ],
    "@semantic-release/changelog",
    ["@semantic-release/npm", { npmPublish: false }],
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};

export default config;
