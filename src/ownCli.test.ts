import path from "node:path";
import { describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { agentShimCliPath, OWN_CLI_FILE_NAME, OwnCliPathUnknownError } from "./ownCli";

describe("agentShimCliPath", () => {
  it("names the command line bundle beside the library file", () => {
    const distDir = path.join(path.sep, "opt", "app", "node_modules", "agent-shim", "dist");
    expect(agentShimCliPath(distDir)).toBe(path.join(distDir, OWN_CLI_FILE_NAME));
    expect(OWN_CLI_FILE_NAME).toBe("cli.cjs");
  });

  it("refuses with a typed error naming the way out when the build recorded no location, as when the sources run unbuilt", () => {
    expect(() => agentShimCliPath()).toThrow(OwnCliPathUnknownError);
    expect(new OwnCliPathUnknownError()).toBeInstanceOf(CliError);
    expect(() => agentShimCliPath()).toThrow(/pass the path of the agent-shim executable explicitly/);
  });
});
