import os from "node:os";

import { describe, expect, it } from "vitest";

import { LaunchRefusedError, resolveClaudeLaunch } from "./launchWiring";

describe("resolveClaudeLaunch", () => {
  it("refuses a launch of an identity that does not exist exactly as a launch is refused, over the real wiring", () => {
    // The suite's throwaway state root holds no identities, so the refusal is reached before any binary is discovered or any state is written.
    let refusal: unknown;
    try {
      resolveClaudeLaunch({ argv: ["@nobody-by-this-name", "--print"], cwd: os.tmpdir(), env: {} });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(LaunchRefusedError);
    expect(refusal).toMatchObject({ exitCode: 1, message: expect.stringContaining('no identity named "nobody-by-this-name"') as unknown });
  });
});
