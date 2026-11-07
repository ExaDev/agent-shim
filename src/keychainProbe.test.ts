import { describe, expect, it, vi } from "vitest";

import { CREDENTIAL_COMMAND_TIMEOUT_MS } from "./credential";
import type { AsyncRun } from "./replayRun";
import type { RunPort } from "./launcher/ports";
import { cliKeychainProbe, doorKeychainProbe } from "./keychainProbe";

describe("doorKeychainProbe", () => {
  it("runs `security` under the bound a non-interactive credential command has, and no other", () => {
    const runner: AsyncRun = async () => await Promise.resolve({ status: 0, stdout: "", stderr: "" });
    const within = vi.fn<(timeoutMs: number) => AsyncRun>(() => runner);
    const probe = doorKeychainProbe("darwin", within);
    expect(within).toHaveBeenCalledExactlyOnceWith(CREDENTIAL_COMMAND_TIMEOUT_MS);
    expect(probe.runAsync).toBe(runner);
  });

  it("carries the platform it is given, since only macOS has a Keychain", () => {
    const within = (): AsyncRun => async () => await Promise.resolve({ status: 0, stdout: "", stderr: "" });
    expect(doorKeychainProbe("darwin", within).platform).toBe("darwin");
    expect(doorKeychainProbe("linux", within).platform).toBe("linux");
  });

  it("runs a real command through the real runner by default", async () => {
    const answer = await doorKeychainProbe("linux").runAsync(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(answer).toEqual({ status: 0, stdout: "ok", stderr: "" });
  });
});

describe("cliKeychainProbe", () => {
  it("runs `security` under the bound a non-interactive credential command has, so a hung lookup ends as a lookup failure instead of hanging the command", () => {
    const runner: RunPort = { run: () => ({ status: 0, stdout: "", stderr: "" }) };
    const within = vi.fn<(timeoutMs: number) => RunPort>(() => runner);
    const probe = cliKeychainProbe("darwin", within);
    expect(within).toHaveBeenCalledExactlyOnceWith(CREDENTIAL_COMMAND_TIMEOUT_MS);
    expect(probe).toEqual({ run: runner, platform: "darwin" });
  });

  it("runs a real command through the real runner by default", () => {
    expect(cliKeychainProbe("linux").run.run(process.execPath, ["-e", "process.stdout.write('ok')"])).toEqual({ status: 0, stdout: "ok", stderr: "" });
  });
});
