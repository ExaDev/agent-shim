import os from "node:os";
import { describe, expect, it, vi } from "vitest";

import type { ProcPort, SpawnPort, SpawnResult } from "./ports";
import { spawnClaude } from "./spawn";

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process would exit with code ${String(code)}`);
  }
}

function fakeProc(): ProcPort {
  return {
    env: {},
    argv: [],
    isProcessAlive: () => true,
    exit: (code: number): never => {
      throw new ExitCalled(code);
    },
  };
}

function fakeSpawn(result: SpawnResult): SpawnPort {
  return {
    spawnSync: vi.fn().mockReturnValue(result),
  };
}

function expectExitCode(fn: () => void): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExitCalled) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected spawnClaude to call proc.exit");
}

describe("spawnClaude", () => {
  it("propagates a clean exit code", () => {
    const spawn = fakeSpawn({ status: 0, signal: null });
    const proc = fakeProc();
    const code = expectExitCode(() =>
      spawnClaude({ bin: "/bin/claude", args: [], env: {}, spawn, proc }),
    );
    expect(code).toBe(0);
  });

  it("propagates a non-zero exit code faithfully", () => {
    const ARBITRARY_NONZERO_EXIT_CODE = 7;
    const spawn = fakeSpawn({ status: ARBITRARY_NONZERO_EXIT_CODE, signal: null });
    const proc = fakeProc();
    const code = expectExitCode(() =>
      spawnClaude({ bin: "/bin/claude", args: [], env: {}, spawn, proc }),
    );
    expect(code).toBe(ARBITRARY_NONZERO_EXIT_CODE);
  });

  it("maps a signal-terminated child to 128 + signal number", () => {
    const SIGNAL_EXIT_CODE_OFFSET = 128;
    const SIGTERM_NUMBER = os.constants.signals.SIGTERM;
    const spawn = fakeSpawn({ status: null, signal: "SIGTERM" });
    const proc = fakeProc();
    const code = expectExitCode(() =>
      spawnClaude({ bin: "/bin/claude", args: [], env: {}, spawn, proc }),
    );
    expect(code).toBe(SIGNAL_EXIT_CODE_OFFSET + SIGTERM_NUMBER);
  });

  it("throws when the child could not even be spawned, instead of exiting cleanly", () => {
    const spawnError = new Error("ENOENT: no such file");
    const spawn = fakeSpawn({ status: null, signal: null, error: spawnError });
    const proc = fakeProc();
    expect(() => spawnClaude({ bin: "/bin/does-not-exist", args: [], env: {}, spawn, proc })).toThrow(
      spawnError,
    );
  });

  it("passes the exact bin, args, env, and stdio:'inherit' through to spawnSync", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, signal: null });
    const spawn: SpawnPort = { spawnSync };
    const proc = fakeProc();
    expectExitCode(() =>
      spawnClaude({
        bin: "/bin/claude",
        args: ["--print", "hello"],
        env: { PATH: "/usr/bin" },
        spawn,
        proc,
      }),
    );
    expect(spawnSync).toHaveBeenCalledWith("/bin/claude", ["--print", "hello"], {
      stdio: "inherit",
      env: { PATH: "/usr/bin" },
    });
  });
});
