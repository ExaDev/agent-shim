import { describe, expect, it } from "vitest";

import { parseLauncherArgv } from "./argv";
import { NativeLaunchConflictError, runNativeLaunch } from "./native";
import { discovered, fakeProc, fakeSpawn, captureExitCode, spawnedEnv } from "../test-helpers";

function launch(argv: readonly string[], env: Readonly<Record<string, string>> = {}): { readonly spawn: ReturnType<typeof fakeSpawn>; readonly resolved: number } {
  const spawn = fakeSpawn();
  let resolved = 0;
  captureExitCode(() => {
    runNativeLaunch({
      parsed: parseLauncherArgv(argv),
      proc: fakeProc(env, argv),
      spawn,
      resolveClaudeBinary: () => {
        resolved += 1;
        return discovered;
      },
    });
  });
  return { spawn, resolved };
}

describe("runNativeLaunch", () => {
  it("runs the discovered claude with every other argument forwarded verbatim, Claude Code's own --bare included", () => {
    const { spawn } = launch(["--native", "--bare", "--print", "hello world"]);
    expect(spawn.spawnSync).toHaveBeenCalledTimes(1);
    const [bin, args] = spawn.spawnSync.mock.calls[0] ?? [];
    expect(bin).toBe(discovered.path);
    expect(args).toEqual(["--bare", "--print", "hello world"]);
  });

  it("hands the child the caller's environment as it is, adding nothing and applying no identity or provider", () => {
    const env = { HOME: "/home/testuser", AGENT_SHIM_IDENTITY: "work", CLAUDE_USE_IDENTITY: "work" };
    const { spawn } = launch(["--native", "--print"], env);
    expect(spawnedEnv(spawn)).toEqual(env);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("refuses to combine --native with any other launch flag, naming each, and spawns nothing", () => {
    for (const [argv, named] of [
      [["@work", "--native"], "@<identity> / --identity"],
      [["--native", "--identity", "work"], "@<identity> / --identity"],
      [["--native", "--provider", "z"], "--provider"],
      [["--native", "--no-provider"], "--no-provider"],
      [["--native", "--claude-version", "2.1.220"], "--claude-version"],
      [["--native", "--headroom"], "--[no-]headroom"],
      [["--native", "--no-track-usage"], "--[no-]track-usage"],
      [["--native", "--skip-permissions"], "--[no-]skip-permissions"],
      [["--native", "--wait"], "--[no-]wait"],
      [["--native", "--config-profile", "p"], "--config-profile"],
      [["--native", "--share", "knowledge/skills"], "--share"],
    ] as const) {
      const spawn = fakeSpawn();
      expect(() => {
        runNativeLaunch({ parsed: parseLauncherArgv(argv), proc: fakeProc({}, argv), spawn, resolveClaudeBinary: () => discovered });
      }).toThrow(new RegExp(named.replace(/[[\]()/<>]/g, "\\$&")));
      expect(spawn.spawnSync).not.toHaveBeenCalled();
    }
    expect(NativeLaunchConflictError.name).toBe("NativeLaunchConflictError");
  });
});
