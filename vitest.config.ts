import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Every test run gets its own throwaway AGENT_SHIM_HOME, well away from Joe's real, currently-in-daily-use identities at ~/.agent-shim/active and ~/.agent-shim/profiles/{mearman,exadev}/. src/test-setup.ts asserts this env var is set and does not resolve to the real ~/.agent-shim before any test body runs, so no test in this project can ever touch real state.
const testAgentShimHome = path.join(os.tmpdir(), `agent-shim-test-${String(process.pid)}-${String(Date.now())}`);

/**
 * A guard against a hung test or hook, not a bound on any work: vitest's default five seconds is exceeded by ordinary CPU-bound tests (certificate generation, the exhaustive walk-policy enumeration) whenever the machine has far more runnable processes than cores, which a shared development machine running many agent sessions routinely does, and the pre-push hook then refuses a push for load alone.
 */
const HANG_GUARD_MS = 120_000;

export default defineConfig({
  test: {
    testTimeout: HANG_GUARD_MS,
    hookTimeout: HANG_GUARD_MS,
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    env: {
      AGENT_SHIM_HOME: testAgentShimHome,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-setup.ts"],
    },
  },
});
