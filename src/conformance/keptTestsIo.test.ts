import { describe, expect, it } from "vitest";

import { CommandTimeout, runCommand } from "./keptTestsIo";

/** A program that outlives any timeout the tests give it. */
const SLEEPER = "setTimeout(() => undefined, 60000)";

/** A timeout short enough that the sleeper is certain to overrun it. */
const SHORT_TIMEOUT_MS = 300;

describe("runCommand", () => {
  it("gives the standard output of a program that finishes", async () => {
    expect(await runCommand(process.execPath, ["-e", "process.stdout.write('done')"])).toBe("done");
  });

  it("stops a program that runs past its timeout and says so as a CommandTimeout, not as a failure", async () => {
    await expect(runCommand(process.execPath, ["-e", SLEEPER], { timeout: SHORT_TIMEOUT_MS })).rejects.toBeInstanceOf(CommandTimeout);
  });

  it("reports a program that fails with its error and its standard error", async () => {
    await expect(runCommand(process.execPath, ["-e", "console.error('why'); process.exit(3)"])).rejects.toThrow(/failed[\s\S]*why/u);
  });
});
