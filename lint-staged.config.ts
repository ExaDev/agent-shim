import type { Configuration } from "lint-staged";

/** ESLint --fix is the project's only formatter (no Prettier). Kept fast on pre-commit; the full test suite runs on pre-push (.husky/pre-push). A plain `.ts` config is safe to load with lint-staged's bare `import()` here specifically because the package is `"type": "module"` — a CommonJS-typed package would need `.mts` instead, since the extension is the only thing that forces ESM regardless of the nearest package.json's own `type` field. */
const config: Configuration = {
  "*.{ts,tsx}": "eslint --fix",
  "src/config/schema.ts": () => ["pnpm schema", "git add schema/"],
};

export default config;
