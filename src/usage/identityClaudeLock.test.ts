import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), wiring: vi.fn() }));

vi.mock("../launcher", () => ({ prepareLaunch: mocks.prepare }));
vi.mock("../launchWiring", () => ({
  buildFarmRuntime: () => ({ runtime: { lock: { isRunning: () => false } } }),
  realPrepareLaunchParams: mocks.wiring,
  resolveClaudeLaunch: () => ({}),
  LaunchRefusedError: class extends Error {},
}));
vi.mock("../replayRun", () => ({ recordRuns: async () => await Promise.resolve(() => ({})) }));

import { buildLayoutPaths } from "../paths";
import { realIsProcessAlive } from "../realPorts";
import { withIdentityClaude } from "./identityClaude";

describe("unattended identity launches", () => {
  it("uses a non-waiting identity names lock on the front door", async () => {
    mocks.wiring.mockImplementation((_paths, options: unknown) => options);
    mocks.prepare.mockReturnValue({ bin: "claude", env: {}, release: () => undefined });
    await withIdentityClaude({ paths: buildLayoutPaths("/unused"), cwd: "/", timeoutMs: 1000, spawnDaemon: () => 0 }, "work", [], async () => { await Promise.resolve(); });
    expect(mocks.prepare.mock.calls[0]?.[0]).toMatchObject({ namesLock: { maxAttempts: 1 } });
  });

  it("checks launch-record liveness without a blocking process-table read", async () => {
    mocks.wiring.mockImplementation((_paths, options: unknown) => options);
    mocks.prepare.mockReturnValue({ bin: "claude", env: {}, release: () => undefined });
    await withIdentityClaude({ paths: buildLayoutPaths("/unused"), cwd: "/", timeoutMs: 1000, spawnDaemon: () => 0 }, "work", [], async () => { await Promise.resolve(); });
    expect(mocks.prepare.mock.calls.at(-1)?.[0]).toMatchObject({ farm: { runtime: { lock: { isRunning: realIsProcessAlive } } } });
  });

  it("does not wait for a held farm lock on the front door", async () => {
    mocks.wiring.mockImplementation((_paths, options: unknown) => options);
    mocks.prepare.mockReturnValue({ bin: "claude", env: {}, release: () => undefined });
    await withIdentityClaude({ paths: buildLayoutPaths("/unused"), cwd: "/", timeoutMs: 1000, spawnDaemon: () => 0 }, "work", [], async () => { await Promise.resolve(); });
    expect(mocks.prepare.mock.calls.at(-1)?.[0]).toMatchObject({ farm: { runtime: { lock: { maxAttempts: 1 } } } });
  });

  it("hands the launcher the inherited environment untouched, since an identity named on its command line outranks an inherited CLAUDE_CONFIG_DIR", async () => {
    mocks.wiring.mockImplementation((_paths, options: unknown) => options);
    mocks.prepare.mockReturnValue({ bin: "claude", env: {}, release: () => undefined });
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/inherited/from/a/session");
    try {
      await withIdentityClaude({ paths: buildLayoutPaths("/unused"), cwd: "/", timeoutMs: 1000, spawnDaemon: () => 0 }, "work", [], async () => { await Promise.resolve(); });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(mocks.prepare.mock.calls.at(-1)?.[0]).toMatchObject({ proc: { argv: ["@work", "--no-provider"], env: { CLAUDE_CONFIG_DIR: "/inherited/from/a/session" } } });
  });
});
