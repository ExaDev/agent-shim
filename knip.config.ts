import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // The headroom measurement harness is bundled and run by scripts/headroom-measure.mts through a path string knip cannot follow. It is not part of the published package, so the dependencies only it imports are traced from its bundled entry and stay devDependencies.
  // The conformance runner is plain JavaScript that the corpus test imports, and the only file that imports Ajv.
  entry: ["src/cli.ts", "src/index.ts", "scripts/headroom-measure-run.ts", "conformance/runner/run.mjs"],
  project: ["src/**/*.ts", "scripts/headroom-measure-*.ts", "conformance/runner/*.mjs"],
  ignoreDependencies: [
    // Referenced by preset/plugin name in release.config.ts, not by import -- knip can't trace this.
    "@semantic-release/npm",
    "conventional-changelog-conventionalcommits",
  ],
  // Runtime-invoked external tools, not npm dependencies: the headroom supervisor spawns `uv tool install` and the headroom proxy itself, so their names appear as spawn literals knip cannot resolve to a package; the statusline's port tests make a FIFO with the system's `mkfifo`, since Node has no call that makes one; the dial smoke script's test runs it under `pwsh`, which every hosted runner has, and skips where it is absent.
  ignoreBinaries: ["headroom", "mkfifo", "pwsh"],
};

export default config;
