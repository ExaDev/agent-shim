import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/cli.ts"],
  project: ["src/**/*.ts"],
  ignoreDependencies: [
    // Referenced by preset/plugin name in release.config.ts, not by import -- knip can't trace this.
    "@semantic-release/npm",
    "conventional-changelog-conventionalcommits",
  ],
  // Runtime-invoked external tools, not npm dependencies: the headroom supervisor spawns `uv tool install` and the headroom proxy itself, so their names appear as spawn literals knip cannot resolve to a package.
  ignoreBinaries: ["headroom", "uv"],
};

export default config;
