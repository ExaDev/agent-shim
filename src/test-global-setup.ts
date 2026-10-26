import * as fs from "node:fs";
import type { TestProject } from "vitest/node";

/**
 * Removes the run's throwaway AGENT_SHIM_HOME (set in vitest.config.ts) once every test file has finished, so a test run leaves nothing behind in the system temp directory.
 */
export default function setup(project: TestProject): () => void {
  const home = project.config.env.AGENT_SHIM_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("AGENT_SHIM_HOME is not set in the vitest config's env.");
  }
  return () => {
    fs.rmSync(home, { recursive: true, force: true });
  };
}
