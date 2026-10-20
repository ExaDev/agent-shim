import os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LaunchRefusedError, resolveClaudeLaunch, resolveClaudeLaunchAsync } from "./launchWiring";
import { BlockingInEventLoopError, enterProcessRole } from "./processRole";
import type { AsyncRun } from "./replayRun";

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

describe("resolveClaudeLaunchAsync", () => {
  let leave: (() => void) | undefined;

  afterEach(() => {
    leave?.();
    leave = undefined;
  });

  const options = { argv: ["@nobody-by-this-name", "--print"], cwd: os.tmpdir(), env: {} };

  it("reaches the same refusal as the synchronous resolution, running the git probe it asks for without blocking", async () => {
    const runAsync = vi.fn<AsyncRun>(async () => await Promise.resolve({ status: 128, stdout: "", stderr: "not a git repository" }));
    await expect(resolveClaudeLaunchAsync(options, runAsync)).rejects.toMatchObject({
      name: "LaunchRefusedError",
      exitCode: 1,
      message: expect.stringContaining('no identity named "nobody-by-this-name"') as unknown,
    });
    expect(runAsync.mock.calls.map(([command, args]) => [command, args[0], args[1]])).toContainEqual(["git", "-C", os.tmpdir()]);
  });

  it("is the resolution the front door can serve: the synchronous one is refused there, this one is not", async () => {
    leave = enterProcessRole("frontdoor-supervisor");
    expect(() => resolveClaudeLaunch(options)).toThrow(BlockingInEventLoopError);
    const runAsync = vi.fn<AsyncRun>(async () => await Promise.resolve({ status: 128, stdout: "", stderr: "" }));
    await expect(resolveClaudeLaunchAsync(options, runAsync)).rejects.toBeInstanceOf(LaunchRefusedError);
  });
});
