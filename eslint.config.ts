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
    rules: {
      // exadev's own consistent-type-imports leaves fixStyle at the rule's default (separate-type-imports); this repo prefers the type keyword inline on the same import statement instead.
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      // This package publishes a library surface, so src/index.ts is its one legitimate barrel: the package entry point. 'single' still bans every other index file and every re-export outside it.
      "exadev/barrel-policy": ["error", { mode: "single" }],
    },
  },
]);
