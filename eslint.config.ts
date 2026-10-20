import { defineConfig } from "eslint/config";
import globals from "globals";
import exadev from "@exadev/eslint-config";

export default defineConfig([
  { ignores: ["dist", "coverage", "node_modules"] },
  {
    languageOptions: {
      // Every file this project lints (src/, scripts/, the various *.config.ts files) is already listed in tsconfig.json's own include -- no allowDefaultProject fallback list needed now that stamp-schema-ids has been converted from .mjs to .mts, closing the one gap that used to require it.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
  },
  ...exadev,
  {
    files: ["src/doctorReport.ts"],
    rules: {
      // This file is the whole-config audit: one section per noun the tool owns, over shared validate-and-report helpers. Splitting it would duplicate those helpers across a file per noun.
      "max-lines": ["error", { max: 1000, skipComments: true }],
    },
  },
  {
    files: ["src/frontdoor/headroomHop.test.ts"],
    rules: {
      // This file is the whole-door integration harness (a fake headroom daemon, a TLS door over the production pipelines) plus one test per hop behaviour; every helper is shared by those tests and splitting it would duplicate the harness. Its size limit is lifted rather than the harness copied.
      "max-lines": ["error", { max: 1000, skipComments: true }],
    },
  },
  {
    files: ["src/launcher.test.ts"],
    rules: {
      // This file walks the whole launch pipeline end to end (guard, decision, daemons, environment) over one shared set of fakes; each launch facet is a test against the same rig, so splitting it would copy the rig. Its size limit is lifted rather than the rig copied.
      "max-lines": ["error", { max: 1000, skipComments: true }],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/blockingSpawn.ts", "src/**/*.test.ts", "src/**/*TestWorld.ts", "src/test-helpers.ts"],
    rules: {
      // A synchronous spawn holds the calling thread for as long as the machine takes to start the process, and in the front door that thread answers every session: a loaded host stalled the door's loop past its watchdog this way. src/blockingSpawn.ts is the one place that calls them, refusing inside the door.
      "no-restricted-imports": [
        "error",
        {
          paths: ["node:child_process", "child_process"].map((name) => ({
            name,
            importNames: ["spawnSync", "execFileSync", "execSync"],
            message: "Use spawnSyncBlocking or execFileSyncBlocking from src/blockingSpawn.ts: they refuse to run inside the front door, whose event loop a synchronous spawn would hold.",
          })),
        },
      ],
    },
  },
  {
    rules: {
      // exadev's own consistent-type-imports leaves fixStyle at the rule's default (separate-type-imports); this repo prefers the type keyword inline on the same import statement instead.
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      // This package publishes a library surface, so src/index.ts is its one legitimate barrel: the package entry point. 'single' still bans every other index file and every re-export outside it.
      "exadev/barrel-policy": ["error", { mode: "single" }],
    },
  },
]);
