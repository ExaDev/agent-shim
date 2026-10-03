import os from "node:os";
import path from "node:path";

// Permanent structural safety net, not a one-off assertion: Joe's real, currently-in-daily-use identities live at ~/.agent-shim/active and ~/.agent-shim/profiles/{mearman,exadev}/. Nothing in this project's test suite may read, write, or touch those paths, directly or indirectly. Every test run must set AGENT_SHIM_HOME to a throwaway directory (vitest.config.ts does this globally), and this file refuses to let a test suite run at all if that has not happened.
const agentShimHome = process.env.AGENT_SHIM_HOME;
const realAgentShimHomes = [path.join(os.homedir(), ".agent-shim"), path.join(os.homedir(), ".claude-use")];

if (agentShimHome === undefined || agentShimHome === "") {
  throw new Error(
    "AGENT_SHIM_HOME is not set. Every test in this project must set AGENT_SHIM_HOME to a " +
      "throwaway directory before running, to guarantee no test can ever touch Joe's real, " +
      "currently-in-daily-use identities under the real ~/.agent-shim.",
  );
}

const realAgentShimHome = realAgentShimHomes.find((real) => path.resolve(agentShimHome) === real);
if (realAgentShimHome !== undefined) {
  throw new Error(
    `AGENT_SHIM_HOME resolves to the real ${realAgentShimHome}. Tests must never point at the ` +
      "real agent-shim root — use a throwaway os.tmpdir() subdirectory instead.",
  );
}
