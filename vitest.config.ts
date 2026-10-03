import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Every test run gets its own throwaway AGENT_SHIM_HOME, well away from Joe's real, currently-in-daily-use identities at ~/.agent-shim/active and ~/.agent-shim/profiles/{mearman,exadev}/. src/test-setup.ts asserts this env var is set and does not resolve to the real ~/.agent-shim before any test body runs, so no test in this project can ever touch real state.
const testAgentShimHome = path.join(os.tmpdir(), `agent-shim-test-${String(process.pid)}-${String(Date.now())}`);

export default defineConfig({
  test: {
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
